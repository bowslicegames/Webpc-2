#include "qemu/osdep.h"
#include "ui/surface.h"
#include "webpc-display-abi.h"
#include "ui/input.h"
#include "qapi/qapi-types-ui.h"
#include "qemu/timer.h"
#define WEBPC_CAPTURE_MAX_PIXELS (2048u * 2048u)

static uint32_t webpc_old_buttons;
static int webpc_last_x, webpc_last_y;
static bool webpc_have_pointer;
static QEMUTimer *webpc_input_timer;
static uint32_t webpc_input_width, webpc_input_height;

static void webpc_process_input(uint32_t width, uint32_t height)
{
    WebPCInputEvent event;
    static uint32_t button_map[INPUT_BUTTON__MAX] = {
        [INPUT_BUTTON_LEFT] = 1u,
        [INPUT_BUTTON_RIGHT] = 2u,
        [INPUT_BUTTON_MIDDLE] = 4u,
    };
    bool changed = false;

    while (webpc_read_input(&event) > 0) {
        if (event.type == 1) {
            int qcode = qemu_input_linux_to_qcode((unsigned int)event.code);
            if (qcode >= 0 && qcode < Q_KEY_CODE__MAX) {
                qemu_input_event_send_key_qcode(NULL, (QKeyCode)qcode,
                                                event.buttons != 0);
                changed = true;
            }
        } else if (event.type == 2) {
            if (event.code == 253) {
                InputButton wheel = event.x < 0 ? INPUT_BUTTON_WHEEL_UP : INPUT_BUTTON_WHEEL_DOWN;
                qemu_input_queue_btn(NULL, wheel, true);
                qemu_input_event_sync();
                qemu_input_queue_btn(NULL, wheel, false);
                qemu_input_event_sync();
                continue;
            } else if (event.code == 254) {
                qemu_input_update_buttons(NULL, button_map, webpc_old_buttons,
                                          (uint32_t)event.buttons);
                webpc_old_buttons = (uint32_t)event.buttons;
                changed = true;
                continue;
            } else if (event.code == 255) {
                qemu_input_queue_rel(NULL, INPUT_AXIS_X, event.x);
                qemu_input_queue_rel(NULL, INPUT_AXIS_Y, event.y);
                changed = true;
                continue;
            } else {
                int x = MAX(0, MIN((int)width - 1, event.x));
                int y = MAX(0, MIN((int)height - 1, event.y));
                if (qemu_input_is_absolute(NULL)) {
                    qemu_input_queue_abs(NULL, INPUT_AXIS_X, x, 0, MAX(1, (int)width - 1));
                    qemu_input_queue_abs(NULL, INPUT_AXIS_Y, y, 0, MAX(1, (int)height - 1));
                } else if (webpc_have_pointer) {
                    qemu_input_queue_rel(NULL, INPUT_AXIS_X, x - webpc_last_x);
                    qemu_input_queue_rel(NULL, INPUT_AXIS_Y, y - webpc_last_y);
                }
                webpc_last_x = x;
                webpc_last_y = y;
                webpc_have_pointer = true;
            }
            qemu_input_update_buttons(NULL, button_map,
                                      webpc_old_buttons, (uint32_t)event.buttons);
            webpc_old_buttons = (uint32_t)event.buttons;
            changed = true;
        }
    }
    if (changed) qemu_input_event_sync();
}

static void webpc_input_timer_cb(void *opaque)
{
    (void)opaque;
    webpc_process_input(webpc_input_width, webpc_input_height);
    timer_mod(webpc_input_timer, qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + 8);
}

void webpc_qemu_capture_surface(DisplaySurface *surface)
{
    static pixman_image_t *rgba_surface;
    static int cached_width, cached_height;
    int width, height;
    if (!surface || is_placeholder(surface)) return;
    width=surface_width(surface); height=surface_height(surface);
    if (width<1 || height<1) return;
    webpc_input_width = (uint32_t)width;
    webpc_input_height = (uint32_t)height;
    if (!webpc_input_timer) {
        webpc_input_timer = timer_new_ms(QEMU_CLOCK_REALTIME, webpc_input_timer_cb, NULL);
        timer_mod(webpc_input_timer, qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + 8);
    }
    webpc_process_input(webpc_input_width, webpc_input_height);
    if ((uint64_t)width*(uint64_t)height>WEBPC_CAPTURE_MAX_PIXELS) return;
    if (!rgba_surface || width!=cached_width || height!=cached_height) {
        if (rgba_surface) pixman_image_unref(rgba_surface);
        rgba_surface=pixman_image_create_bits(PIXMAN_a8b8g8r8,width,height,NULL,0);
        if (!rgba_surface) { cached_width=cached_height=0; return; }
        cached_width=width; cached_height=height;
    }
    pixman_image_composite32(PIXMAN_OP_SRC,surface->image,NULL,rgba_surface,
                             0,0,0,0,0,0,width,height);
    webpc_publish_frame((const uint8_t *)pixman_image_get_data(rgba_surface),
                        (uint32_t)width,(uint32_t)height);
}
