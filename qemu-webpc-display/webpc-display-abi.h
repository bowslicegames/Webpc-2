#ifndef WEBPC_DISPLAY_ABI_H
#define WEBPC_DISPLAY_ABI_H

#include <stdint.h>

/*
 * ABI between the QEMU display backend and graphics-qemu-adapter.js.
 * The QEMU display callback must copy a completed scanout into an RGBA8888
 * buffer and increment generation only after the copy is complete.
 *
 * The buffer must remain valid until the next frame update. JavaScript copies
 * it into a separate Uint8Array before drawing so QEMU may safely reuse it.
 */
#ifdef __cplusplus
extern "C" {
#endif

uint32_t webpc_get_framebuffer_ptr(void);
uint32_t webpc_get_framebuffer_width(void);
uint32_t webpc_get_framebuffer_height(void);
uint32_t webpc_get_framebuffer_generation(void);

/* type: 1=key, 2=pointer. Returns 0 when the event was accepted. */
int32_t webpc_send_input(int32_t type, int32_t code,
                         int32_t x, int32_t y, int32_t buttons);

#ifdef __cplusplus
}
#endif
#endif
