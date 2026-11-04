#include "webpc-display-abi.h"
#include <stdlib.h>
#include <string.h>
#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define WEBPC_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define WEBPC_EXPORT __attribute__((visibility("default")))
#endif
#define WEBPC_MAX_WIDTH 2048u
#define WEBPC_MAX_HEIGHT 2048u
#define INPUT_QUEUE_CAPACITY 256u
static uint8_t *framebuffer;
static uint32_t fb_width, fb_height, fb_generation;
static WebPCInputEvent queue[INPUT_QUEUE_CAPACITY];
static uint32_t rd, wr, dropped;
WEBPC_EXPORT int webpc_publish_frame(const uint8_t *rgba, uint32_t width, uint32_t height) {
    if (!rgba || !width || !height || width > WEBPC_MAX_WIDTH || height > WEBPC_MAX_HEIGHT ||
        (uint64_t)width * height * 4u > SIZE_MAX) return -1;
    /* Allocate once at the maximum supported size. Keeping the address stable
       prevents JS HEAPU8 readers racing a realloc during a display resize. */
    if (!framebuffer) {
        framebuffer = (uint8_t *)malloc((size_t)WEBPC_MAX_WIDTH * WEBPC_MAX_HEIGHT * 4u);
        if (!framebuffer) return -2;
    }
    fb_generation = (fb_generation + 1u) | 1u; /* odd means a frame is in flight */
    __sync_synchronize();
    memcpy(framebuffer, rgba, (size_t)width * height * 4u);
    fb_width = width;
    fb_height = height;
    __sync_synchronize();
    ++fb_generation; /* even means a complete frame is published */
    return 0;
}

WEBPC_EXPORT WebPCFramebufferPtr webpc_get_framebuffer_ptr(void) { return (WebPCFramebufferPtr)(uintptr_t)framebuffer; }
WEBPC_EXPORT uint32_t webpc_get_framebuffer_width(void) { return fb_width; }
WEBPC_EXPORT uint32_t webpc_get_framebuffer_height(void) { return fb_height; }
WEBPC_EXPORT uint32_t webpc_get_framebuffer_generation(void) { return fb_generation; }
WEBPC_EXPORT int32_t webpc_send_input(int32_t type, int32_t code, int32_t x, int32_t y, int32_t buttons) {
    if ((type != 1 && type != 2) || wr - rd >= INPUT_QUEUE_CAPACITY) { ++dropped; return -1; }
    WebPCInputEvent *event = &queue[wr % INPUT_QUEUE_CAPACITY];
    event->type=type; event->code=code; event->x=x; event->y=y; event->buttons=buttons;
    __sync_synchronize(); ++wr; return 0;
}
WEBPC_EXPORT int32_t webpc_read_input(WebPCInputEvent *event) {
    if (!event || rd == wr) return 0;
    __sync_synchronize(); *event=queue[rd % INPUT_QUEUE_CAPACITY]; ++rd; return 1;
}
WEBPC_EXPORT uint32_t webpc_dropped_input_events(void) { return dropped; }
