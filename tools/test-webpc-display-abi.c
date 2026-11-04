#include "webpc-display-abi.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    uint8_t first[2 * 2 * 4], second[4 * 2 * 4];
    memset(first, 0x31, sizeof(first));
    memset(second, 0x7a, sizeof(second));
    assert(webpc_publish_frame(first, 2, 2) == 0);
    uint32_t ptr = webpc_get_framebuffer_ptr();
    uint32_t generation = webpc_get_framebuffer_generation();
    assert(ptr != 0 && (generation & 1u) == 0);
    assert(webpc_get_framebuffer_width() == 2);
    assert(webpc_get_framebuffer_height() == 2);
    assert(memcmp((const void *)(uintptr_t)ptr, first, sizeof(first)) == 0);

    assert(webpc_publish_frame(second, 4, 2) == 0);
    assert(webpc_get_framebuffer_ptr() == ptr);
    assert(webpc_get_framebuffer_generation() != generation);
    assert((webpc_get_framebuffer_generation() & 1u) == 0);
    assert(webpc_get_framebuffer_width() == 4);
    assert(webpc_get_framebuffer_height() == 2);
    assert(memcmp((const void *)(uintptr_t)ptr, second, sizeof(second)) == 0);

    assert(webpc_send_input(1, 42, 0, 0, 1) == 0);
    WebPCInputEvent event = {0};
    assert(webpc_read_input(&event) == 1);
    assert(event.type == 1 && event.code == 42 && event.buttons == 1);
    assert(webpc_read_input(&event) == 0);
    assert(webpc_publish_frame(first, 0, 2) == -1);
    puts("WebPC display ABI runtime tests passed.");
    return 0;
}
