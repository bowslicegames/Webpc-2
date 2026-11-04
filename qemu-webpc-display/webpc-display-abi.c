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
    uint32_t generation = __atomic_load_n(&fb_generation, __ATOMIC_RELAXED);
    generation = (generation & ~1u) + 1u;
    __atomic_store_n(&fb_generation, generation, __ATOMIC_RELEASE); /* odd: writer active */
    memcpy(framebuffer, rgba, (size_t)width * height * 4u);
    __atomic_store_n(&fb_width, width, __ATOMIC_RELAXED);
    __atomic_store_n(&fb_height, height, __ATOMIC_RELAXED);
    __atomic_store_n(&fb_generation, generation + 1u, __ATOMIC_RELEASE); /* even: frame complete */
    return 0;
}

WEBPC_EXPORT WebPCFramebufferPtr webpc_get_framebuffer_ptr(void) {
    uint8_t *ptr = __atomic_load_n(&framebuffer, __ATOMIC_ACQUIRE);
    return (WebPCFramebufferPtr)(uintptr_t)ptr;
}
WEBPC_EXPORT uint32_t webpc_get_framebuffer_width(void) { return __atomic_load_n(&fb_width, __ATOMIC_ACQUIRE); }
WEBPC_EXPORT uint32_t webpc_get_framebuffer_height(void) { return __atomic_load_n(&fb_height, __ATOMIC_ACQUIRE); }
WEBPC_EXPORT uint32_t webpc_get_framebuffer_generation(void) { return __atomic_load_n(&fb_generation, __ATOMIC_ACQUIRE); }
WEBPC_EXPORT int32_t webpc_send_input(int32_t type, int32_t code, int32_t x, int32_t y, int32_t buttons) {
    if (type != 1 && type != 2) return -2;
    uint32_t write_at = __atomic_load_n(&wr, __ATOMIC_RELAXED);
    uint32_t read_at = __atomic_load_n(&rd, __ATOMIC_ACQUIRE);
    if (write_at - read_at >= INPUT_QUEUE_CAPACITY) {
        __atomic_add_fetch(&dropped, 1u, __ATOMIC_RELAXED);
        return -1;
    }
    WebPCInputEvent *event = &queue[write_at % INPUT_QUEUE_CAPACITY];
    event->type=type; event->code=code; event->x=x; event->y=y; event->buttons=buttons;
    __atomic_store_n(&wr, write_at + 1u, __ATOMIC_RELEASE);
    return 0;
}
WEBPC_EXPORT int32_t webpc_read_input(WebPCInputEvent *event) {
    if (!event) return -1;
    uint32_t read_at = __atomic_load_n(&rd, __ATOMIC_RELAXED);
    uint32_t write_at = __atomic_load_n(&wr, __ATOMIC_ACQUIRE);
    if (read_at == write_at) return 0;
    *event=queue[read_at % INPUT_QUEUE_CAPACITY];
    __atomic_store_n(&rd, read_at + 1u, __ATOMIC_RELEASE);
    return 1;
}
WEBPC_EXPORT uint32_t webpc_dropped_input_events(void) { return __atomic_load_n(&dropped, __ATOMIC_RELAXED); }
