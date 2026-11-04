#ifndef WEBPC_DISPLAY_ABI_H
#define WEBPC_DISPLAY_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* RGBA8888 scanout ABI. The producer publishes only complete frames. */
uint32_t webpc_get_framebuffer_ptr(void);
uint32_t webpc_get_framebuffer_width(void);
uint32_t webpc_get_framebuffer_height(void);
uint32_t webpc_get_framebuffer_generation(void);
int webpc_publish_frame(const uint8_t *rgba, uint32_t width, uint32_t height);

/* Bounded input mailbox. QEMU main-loop integration must drain this queue. */
typedef struct WebPCInputEvent {
    int32_t type;     /* 1 key, 2 pointer */
    int32_t code;
    int32_t x;
    int32_t y;
    int32_t buttons;
} WebPCInputEvent;

int32_t webpc_send_input(int32_t type, int32_t code,
                         int32_t x, int32_t y, int32_t buttons);
int32_t webpc_read_input(WebPCInputEvent *event);
uint32_t webpc_dropped_input_events(void);

#ifdef __cplusplus
}
#endif
#endif
