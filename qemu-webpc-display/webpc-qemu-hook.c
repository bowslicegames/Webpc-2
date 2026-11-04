#include "qemu/osdep.h"
#include "ui/surface.h"
#include "webpc-display-abi.h"
#define WEBPC_CAPTURE_MAX_PIXELS (2048u * 2048u)
void webpc_qemu_capture_surface(DisplaySurface *surface)
{
    static pixman_image_t *rgba_surface;
    static int cached_width, cached_height;
    int width, height;
    if (!surface || is_placeholder(surface)) return;
    width=surface_width(surface); height=surface_height(surface);
    if (width<1 || height<1 || (uint64_t)width*(uint64_t)height>WEBPC_CAPTURE_MAX_PIXELS) return;
    if (!rgba_surface || width!=cached_width || height!=cached_height) {
        if (rgba_surface) pixman_image_unref(rgba_surface);
        rgba_surface=pixman_image_create_bits(PIXMAN_r8g8b8a8,width,height,NULL,0);
        if (!rgba_surface) { cached_width=cached_height=0; return; }
        cached_width=width; cached_height=height;
    }
    pixman_image_composite32(PIXMAN_OP_SRC,surface->image,NULL,rgba_surface,
                             0,0,0,0,0,0,width,height);
    webpc_publish_frame((const uint8_t *)pixman_image_get_data(rgba_surface),
                        (uint32_t)width,(uint32_t)height);
}
