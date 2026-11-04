#include "webpc-display-abi.h"
#include <stdlib.h>
#include <string.h>
#define WEBPC_MAX_WIDTH 4096u
#define WEBPC_MAX_HEIGHT 4096u
#define INPUT_QUEUE_CAPACITY 256u
static uint8_t *framebuffer;
static uint32_t fb_width, fb_height, fb_generation;
static WebPCInputEvent queue[INPUT_QUEUE_CAPACITY];
static uint32_t rd, wr, dropped;
int webpc_publish_frame(const uint8_t *rgba, uint32_t width, uint32_t height) {
 if (!rgba || !width || !height || width>WEBPC_MAX_WIDTH || height>WEBPC_MAX_HEIGHT ||
     (uint64_t)width*height*4u>SIZE_MAX) return -1;
 size_t n=(size_t)width*height*4u;
 uint8_t *p=(uint8_t*)realloc(framebuffer,n); if(!p)return -2;
 framebuffer=p; memcpy(p,rgba,n); fb_width=width; fb_height=height;
 __sync_synchronize(); ++fb_generation; return 0;
}
uint32_t webpc_get_framebuffer_ptr(void){return (uint32_t)(uintptr_t)framebuffer;}
uint32_t webpc_get_framebuffer_width(void){return fb_width;}
uint32_t webpc_get_framebuffer_height(void){return fb_height;}
uint32_t webpc_get_framebuffer_generation(void){return fb_generation;}
int32_t webpc_send_input(int32_t type,int32_t code,int32_t x,int32_t y,int32_t buttons){
 if((type!=1&&type!=2)||wr-rd>=INPUT_QUEUE_CAPACITY){++dropped;return -1;}
 WebPCInputEvent *e=&queue[wr%INPUT_QUEUE_CAPACITY];
 e->type=type;e->code=code;e->x=x;e->y=y;e->buttons=buttons;
 __sync_synchronize();++wr;return 0;
}
int32_t webpc_read_input(WebPCInputEvent *e){
 if (!e || rd == wr) return 0;\n __sync_synchronize();\n *e = queue[rd % INPUT_QUEUE_CAPACITY];\n ++rd;\n return 1;
}
uint32_t webpc_dropped_input_events(void){return dropped;}
