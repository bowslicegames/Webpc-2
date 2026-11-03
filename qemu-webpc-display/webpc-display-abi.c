/*
 * QEMU-Wasm display backend integration starter.
 *
 * This file documents the small Emscripten ABI expected by the browser
 * adapter. It is deliberately not a fake display backend: the QEMU display
 * callback must call webpc_publish_frame() with actual guest scanout pixels.
 */
#include "webpc-display-abi.h"
#include <stdlib.h>
#include <string.h>

#define WEBPC_MAX_WIDTH 4096
#define WEBPC_MAX_HEIGHT 4096

static uint8_t *framebuffer;
static uint32_t fb_width, fb_height, fb_generation;
static int32_t last_input_type, last_input_code, last_input_x, last_input_y, last_input_buttons;

int webpc_publish_frame(const uint8_t *rgba, uint32_t width, uint32_t height) {
    if (!rgba || !width || !height || width > WEBPC_MAX_WIDTH ||
        height > WEBPC_MAX_HEIGHT || (uint64_t)width * height * 4 > SIZE_MAX)
        return -1;
    size_t bytes = (size_t)width * height * 4;
    uint8_t *next = realloc(framebuffer, bytes);
    if (!next) return -2;
    framebuffer = next;
    memcpy(framebuffer, rgba, bytes);
    fb_width = width;
    fb_height = height;
    __sync_synchronize();
    fb_generation++;
    return 0;
}

uint32_t webpc_get_framebuffer_ptr(void) { return (uint32_t)(uintptr_t)framebuffer; }
uint32_t webpc_get_framebuffer_width(void) { return fb_width; }
uint32_t webpc_get_framebuffer_height(void) { return fb_height; }
uint32_t webpc_get_framebuffer_generation(void) { return fb_generation; }

int32_t webpc_send_input(int32_t type, int32_t code, int32_t x, int32_t y, int32_t buttons) {
    last_input_type = type;
    last_input_code = code;
    last_input_x = x;
    last_input_y = y;
    last_input_buttons = buttons;
    /* TODO: enqueue this event for QEMU's active input device on its main loop. */
    return 0;
}
