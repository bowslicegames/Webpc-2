#ifndef WEBPC_DISPLAY_ABI_H
#define WEBPC_DISPLAY_ABI_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifdef WEBPC_NATIVE_TEST
typedef uintptr_t WebPCFramebufferPtr;
#else
typedef uint32_t WebPCFramebufferPtr;
#endif
WebPCFramebufferPtr webpc_get_framebuffer_ptr(void);
uint32_t webpc_get_framebuffer_width(void);
uint32_t webpc_get_framebuffer_height(void);
uint32_t webpc_get_framebuffer_generation(void);
int webpc_publish_frame(const uint8_t *rgba, uint32_t width, uint32_t height);
typedef struct WebPCInputEvent { int32_t type, code, x, y, buttons; } WebPCInputEvent;
int32_t webpc_send_input(int32_t type, int32_t code, int32_t x, int32_t y, int32_t buttons);
int32_t webpc_read_input(WebPCInputEvent *event);
uint32_t webpc_dropped_input_events(void);
#ifdef __cplusplus
}
#endif
#endif
