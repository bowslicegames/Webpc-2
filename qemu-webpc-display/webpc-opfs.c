/*
 * WebPC OPFS block protocol driver.
 *
 * The QEMU main loop runs on an Emscripten pthread.  That dedicated worker
 * opens an Origin Private File System SyncAccessHandle and performs
 * synchronous random-access I/O against it.  The initial qcow2 image is
 * populated by the browser before QEMU starts; all later guest writes go
 * directly to OPFS instead of growing MEMFS/WebAssembly linear memory.
 */
#include "qemu/osdep.h"
#include <emscripten.h>
#include "qapi/error.h"
#include "qapi/qmp/qdict.h"
#include "qemu/module.h"
#include "block/block-io.h"
#include "block/block_int.h"

typedef struct WebPCOPFSState {
    char *filename;
    bool opened;
} WebPCOPFSState;

EM_ASYNC_JS(int, webpc_opfs_open, (const char *filename), {
    try {
        const name = UTF8ToString(filename);
        if (!navigator.storage || !navigator.storage.getDirectory) {
            throw new Error("OPFS is not available in this browser worker");
        }
        if (globalThis.__webpcOpfsAccessHandle) {
            try { globalThis.__webpcOpfsAccessHandle.close(); } catch (_) {}
            globalThis.__webpcOpfsAccessHandle = null;
        }
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(name, { create: false });
        globalThis.__webpcOpfsAccessHandle = await file.createSyncAccessHandle();
        return 0;
    } catch (error) {
        console.error("WebPC OPFS open failed:", error);
        return -1;
    }
});

EM_JS(int, webpc_opfs_read, (void *buffer, int length, double offset), {
    try {
        const handle = globalThis.__webpcOpfsAccessHandle;
        if (!handle) return -1;
        const view = HEAPU8.subarray(buffer, buffer + length);
        return handle.read(view, { at: offset });
    } catch (error) {
        console.error("WebPC OPFS read failed:", error);
        return -1;
    }
});

EM_JS(int, webpc_opfs_write, (const void *buffer, int length, double offset), {
    try {
        const handle = globalThis.__webpcOpfsAccessHandle;
        if (!handle) return -1;
        const view = HEAPU8.subarray(buffer, buffer + length);
        return handle.write(view, { at: offset });
    } catch (error) {
        console.error("WebPC OPFS write failed:", error);
        return -1;
    }
});

EM_JS(double, webpc_opfs_get_size, (void), {
    try {
        const handle = globalThis.__webpcOpfsAccessHandle;
        return handle ? handle.getSize() : -1;
    } catch (error) {
        console.error("WebPC OPFS size query failed:", error);
        return -1;
    }
});

EM_JS(int, webpc_opfs_truncate, (double size), {
    try {
        const handle = globalThis.__webpcOpfsAccessHandle;
        if (!handle) return -1;
        handle.truncate(size);
        return 0;
    } catch (error) {
        console.error("WebPC OPFS truncate failed:", error);
        return -1;
    }
});

EM_JS(int, webpc_opfs_flush, (void), {
    try {
        const handle = globalThis.__webpcOpfsAccessHandle;
        if (!handle) return -1;
        handle.flush();
        return 0;
    } catch (error) {
        console.error("WebPC OPFS flush failed:", error);
        return -1;
    }
});

EM_JS(void, webpc_opfs_close_handle, (void), {
    try {
        if (globalThis.__webpcOpfsAccessHandle) {
            globalThis.__webpcOpfsAccessHandle.close();
            globalThis.__webpcOpfsAccessHandle = null;
        }
    } catch (error) {
        console.error("WebPC OPFS close failed:", error);
    }
});

static void webpc_opfs_parse_filename(const char *filename, QDict *options,
                                      Error **errp)
{
    static const char prefix[] = "webpc-opfs:";
    if (!g_str_has_prefix(filename, prefix) || !filename[sizeof(prefix) - 1]) {
        error_setg(errp, "WebPC OPFS filename must use webpc-opfs:<file>");
        return;
    }
    qdict_put_str(options, "filename", filename + sizeof(prefix) - 1);
}

static int webpc_opfs_file_open(BlockDriverState *bs, QDict *options,
                                int flags, Error **errp)
{
    WebPCOPFSState *state = bs->opaque;
    const char *filename = qdict_get_try_str(options, "filename");
    int ret;
    (void)flags;

    if (!filename || !*filename || strchr(filename, '/') ||
        strchr(filename, '\\') || !strcmp(filename, ".") ||
        !strcmp(filename, "..")) {
        error_setg(errp, "WebPC OPFS accepts a single safe filename");
        return -EINVAL;
    }

    state->filename = g_strdup(filename);
    /* The block layer validates unconsumed protocol options after open. */
    qdict_del(options, "filename");
    ret = webpc_opfs_open(state->filename);
    if (ret < 0) {
        error_setg(errp, "Unable to open OPFS disk '%s'; check browser storage permission and disk initialization",
                   state->filename);
        g_clear_pointer(&state->filename, g_free);
        return -EIO;
    }

    state->opened = true;
    bs->supported_write_flags = BDRV_REQ_FUA;
    return 0;
}

static int64_t coroutine_fn webpc_opfs_co_getlength(BlockDriverState *bs)
{
    WebPCOPFSState *state = bs->opaque;
    double size;
    if (!state->opened) return -EIO;
    size = webpc_opfs_get_size();
    return size < 0 ? -EIO : (int64_t)size;
}

static int64_t coroutine_fn
webpc_opfs_co_get_allocated_file_size(BlockDriverState *bs)
{
    return webpc_opfs_co_getlength(bs);
}

static int coroutine_fn webpc_opfs_co_preadv(BlockDriverState *bs,
                                              int64_t offset, int64_t bytes,
                                              QEMUIOVector *qiov,
                                              BdrvRequestFlags flags)
{
    WebPCOPFSState *state = bs->opaque;
    int64_t position = offset;
    int i;
    (void)bytes;
    (void)flags;

    if (!state->opened) return -EIO;
    for (i = 0; i < qiov->niov; i++) {
        size_t length = qiov->iov[i].iov_len;
        int got;
        if (length > INT_MAX) return -EIO;
        got = webpc_opfs_read(qiov->iov[i].iov_base, (int)length,
                              (double)position);
        if (got < 0 || (size_t)got > length) return -EIO;
        if ((size_t)got < length) {
            memset((uint8_t *)qiov->iov[i].iov_base + got, 0, length - got);
        }
        position += (int64_t)length;
    }
    return 0;
}

static int coroutine_fn webpc_opfs_co_pwritev(BlockDriverState *bs,
                                               int64_t offset, int64_t bytes,
                                               QEMUIOVector *qiov,
                                               BdrvRequestFlags flags)
{
    WebPCOPFSState *state = bs->opaque;
    int64_t position = offset;
    int i;
    (void)bytes;
    (void)flags;

    if (!state->opened) return -EIO;
    for (i = 0; i < qiov->niov; i++) {
        size_t length = qiov->iov[i].iov_len;
        int written;
        if (length > INT_MAX) return -EIO;
        written = webpc_opfs_write(qiov->iov[i].iov_base, (int)length,
                                   (double)position);
        if (written < 0 || (size_t)written != length) return -EIO;
        position += (int64_t)length;
    }
    return 0;
}

static int coroutine_fn webpc_opfs_co_flush_to_disk(BlockDriverState *bs)
{
    WebPCOPFSState *state = bs->opaque;
    if (!state->opened) return -EIO;
    return webpc_opfs_flush() == 0 ? 0 : -EIO;
}

static int coroutine_fn webpc_opfs_co_truncate(BlockDriverState *bs,
                                                int64_t offset, bool exact,
                                                PreallocMode prealloc,
                                                BdrvRequestFlags flags,
                                                Error **errp)
{
    WebPCOPFSState *state = bs->opaque;
    (void)exact;
    (void)flags;
    if (!state->opened || offset < 0) return -EINVAL;
    if (prealloc != PREALLOC_MODE_OFF) {
        error_setg(errp, "WebPC OPFS does not support preallocation");
        return -ENOTSUP;
    }
    if (!exact) {
        double current_size = webpc_opfs_get_size();
        if (current_size < 0) return -EIO;
        if (current_size >= (double)offset) return 0;
    }
    if (webpc_opfs_truncate((double)offset) != 0) {
        error_setg(errp, "Unable to resize OPFS disk '%s'", state->filename);
        return -EIO;
    }
    return 0;
}

static void webpc_opfs_close(BlockDriverState *bs)
{
    WebPCOPFSState *state = bs->opaque;
    if (state->opened) {
        webpc_opfs_close_handle();
        state->opened = false;
    }
    g_clear_pointer(&state->filename, g_free);
}

static BlockDriver bdrv_webpc_opfs = {
    .format_name = "webpc-opfs",
    .protocol_name = "webpc-opfs",
    /* QEMU strips the parsed filename unless the protocol driver declares it needs one. */
    .bdrv_needs_filename = true,
    .instance_size = sizeof(WebPCOPFSState),
    .bdrv_file_open = webpc_opfs_file_open,
    .bdrv_parse_filename = webpc_opfs_parse_filename,
    .bdrv_close = webpc_opfs_close,
    .bdrv_co_getlength = webpc_opfs_co_getlength,
    .bdrv_co_get_allocated_file_size = webpc_opfs_co_get_allocated_file_size,
    .bdrv_co_preadv = webpc_opfs_co_preadv,
    .bdrv_co_pwritev = webpc_opfs_co_pwritev,
    .bdrv_co_flush_to_disk = webpc_opfs_co_flush_to_disk,
    .bdrv_co_truncate = webpc_opfs_co_truncate,
};

static void bdrv_webpc_opfs_init(void)
{
    bdrv_register(&bdrv_webpc_opfs);
}

block_init(bdrv_webpc_opfs_init);
