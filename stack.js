var accepted = false;

// Send guest HTTP(S) requests through the same-origin Cloudflare Worker relay.
// This avoids browser CORS blocking upstream sites before the guest can receive
// their responses. The Worker validates the destination and performs the fetch.
function fetchWebPCRequest(address, request) {
    const headers = new Headers(request.headers || {});
    headers.set("X-WebPC-Proxy-Target", address);

    const relayRequest = {
        ...request,
        headers,
        mode: "same-origin",
        credentials: "omit"
    };

    return fetch(new URL("/net-proxy", window.location.origin).toString(), relayRequest);
}
let curSocket = null;
let eventQueue = [];
// Offset into eventQueue[0] when a WebSocket frame is larger than the
// currently available ring-buffer space.
let eventQueueOffset = 0;
let sockSendRetryScheduled = false;

function scheduleSockSend(delay = 1) {
    if (sockSendRetryScheduled || eventQueue.length === 0) return;
    sockSendRetryScheduled = true;
    setTimeout(() => {
        sockSendRetryScheduled = false;
        sockSend();
    }, delay);
}
let stackWorker = null;

// Mimimum WebSocket mock which implements only fields used by the emscripten runtime.
// TODO: Add more fields
function emscriptenMockWebSocket(address, onconnection) {
    const WindowWebSocket = window.WebSocket;

    class EmscriptenMockWebSocket {
        constructor(url, protocols) {
            this.url = url;
            this.protocol = protocols;
            this.binaryType = "arraybuffer";
            this.CONNECTING = 0;
            this.OPEN = 1;
            this.CLOSING = 2;
            this.CLOSED = 3;
            this.readyState = this.CONNECTING;

            if (this.url != address) {
                return new WindowWebSocket(url, protocols);
            }

            const client = {};

            client.send = (data) => {
                queueMicrotask(() => {if (this.onmessage) this.onmessage({ data: data })});
            };

            this.send = (data) => {
                if (this.readyState !== 1) throw new Error("WebSocket is not open");
                queueMicrotask(() => {if (client.onmessage) client.onmessage({ data: data })});
            };

            this.close = (code = 1000, reason = "") => {
                this.readyState = this.CLOSED;
            };

            queueMicrotask(() => {
                if (!onconnection(client)) return;
                this.readyState = this.OPEN;
                if (this.onopen) this.onopen();
            });
        }
    }

    window.WebSocket = EmscriptenMockWebSocket;
}

export function Start(address, stackWorkerFile, stackImage, readyCallback) {
    emscriptenMockWebSocket(address, (client) => {
        if (curSocket != null) {
            console.log("duplicated");
            return false;
        }
        curSocket = client;
        sockAccept();
        client.onmessage = (event) => {
            if (!accepted) {
                return;
            }
            eventQueue.push(new Uint8Array(event.data));
            sockSend(); // pass data from qemu to c2w-net-proxy.wasm
        }
        return true;
    });

    stackWorker = new Worker(stackWorkerFile);

    let conn = createStack(stackWorker, stackImage, readyCallback);
    registerConnBuffer(conn.toNet, conn.fromNet);
    registerMetaBuffer(conn.metaFromNet);
}

var toNetCtrl;
var toNetBegin;
var toNetEnd;
var toNetNotify;
var toNetData;
var fromNetCtrl;
var fromNetBegin;
var fromNetEnd;
var fromNetData;
function registerConnBuffer(to, from) {
    toNetCtrl = new Int32Array(to, 0, 1);
    toNetBegin = new Int32Array(to, 4, 1);
    toNetEnd = new Int32Array(to, 8, 1);
    toNetNotify = new Int32Array(to, 12, 1);
    toNetData = new Uint8Array(to, 16);
    fromNetCtrl = new Int32Array(from, 0, 1);
    fromNetBegin = new Int32Array(from, 4, 1);
    fromNetEnd = new Int32Array(from, 8, 1);
    fromNetData = new Uint8Array(from, 12);
}

var metaFromNetCtrl;
var metaFromNetBegin;
var metaFromNetEnd;
var metaFromNetStatus;
var metaFromNetData;
function registerMetaBuffer(meta) {
    metaFromNetCtrl = new Int32Array(meta, 0, 1);
    metaFromNetBegin = new Int32Array(meta, 4, 1);
    metaFromNetEnd = new Int32Array(meta, 8, 1);
    metaFromNetStatus = new Int32Array(meta, 12, 1);
    metaFromNetData = new Uint8Array(meta, 16);
}

function sockAccept(){
    accepted = true;
    return true;
}

function sockSend(){
    if (eventQueue.length === 0) return 0;

    // Only one producer may write to the shared ring buffer at a time.
    if (Atomics.compareExchange(toNetCtrl, 0, 0, 1) != 0) {
        scheduleSockSend(1);
        return 0;
    }

    let copied = 0;
    let hasPendingData = false;
    try {
        // Do not remove a frame from the queue until every byte has been
        // copied. A frame can be larger than the ring buffer, so retain an
        // offset and copy it in safe chunks as the consumer frees space.
        while (eventQueue.length > 0) {
            const data = eventQueue[0];
            if (eventQueueOffset >= data.length) {
                eventQueue.shift();
                eventQueueOffset = 0;
                continue;
            }

            const capacity = toNetData.byteLength;
            const begin = toNetBegin[0];
            const end = toNetEnd[0];

            // The ring buffer reserves one byte to distinguish full from
            // empty. All indices are kept in [0, capacity).
            const used = end >= begin
                ? end - begin
                : capacity - begin + end;
            const free = capacity - used - 1;
            if (free <= 0) {
                hasPendingData = true;
                break;
            }

            // Copy only the contiguous segment at the end of the ring. The
            // next scheduled call will wrap to index zero if necessary.
            const contiguous = end >= begin
                ? capacity - end
                : begin - end - 1;
            const count = Math.min(data.length - eventQueueOffset, free, contiguous);
            if (count <= 0) {
                hasPendingData = true;
                break;
            }

            toNetData.set(data.subarray(eventQueueOffset, eventQueueOffset + count), end);
            toNetEnd[0] = (end + count) % capacity;
            eventQueueOffset += count;
            copied += count;

            if (eventQueueOffset >= data.length) {
                eventQueue.shift();
                eventQueueOffset = 0;
            } else {
                // Avoid monopolising the producer lock on large frames.
                hasPendingData = true;
                break;
            }
        }
        hasPendingData = hasPendingData || eventQueue.length > 0;
    } finally {
        if (Atomics.compareExchange(toNetCtrl, 0, 1, 0) != 1) {
            console.log("UNEXPECTED STATUS");
        }
        Atomics.notify(toNetCtrl, 0, 1);
    }

    if (copied > 0) {
        Atomics.store(toNetNotify, 0, 1);
        Atomics.notify(toNetNotify, 0);
    }
    if (hasPendingData) {
        // Poll briefly for the consumer to advance toNetBegin; never drop
        // data merely because the shared buffer is temporarily full.
        scheduleSockSend(1);
    }
    return copied;
}

function sockRecvWS(targetLen){
    if (!accepted) {
        return -1;
    }

    if (Atomics.compareExchange(fromNetCtrl, 0, 0, 1) != 0) {
        sockRecvWS(targetLen);
        return;
    }
    let begin = fromNetBegin[0]; //inclusive
    let end = fromNetEnd[0]; //exclusive
    var len;
    var round;
    if (end >= begin) {
        len = end - begin;
        round = 0;
    } else {
        len = fromNetData.byteLength - begin;
        round = end;
    }
    if (targetLen < len) {
        len = targetLen;
        round = 0;
    } else if (targetLen < len + round) {
        round = targetLen - len;
    }
    let targetBuf = new Uint8Array(len + round);
    if (len > 0) {
        targetBuf.set(fromNetData.subarray(begin, begin + len), 0);
        fromNetBegin[0] = begin + len;
    }
    if (round > 0) {
        targetBuf.set(fromNetData.subarray(0, round), len);
        fromNetBegin[0] = round;
    }

    curSocket.send(targetBuf);
    
    if (Atomics.compareExchange(fromNetCtrl, 0, 1, 0) != 1) {
        console.log("UNEXPECTED STATUS");
    }
    Atomics.notify(fromNetCtrl, 0, 1);

    return (len + round);
}

export function RecvCert(){
    var buf = new Uint8Array(0);
    return new Promise((resolve, reject) => {
        function getCert(){
            var done = false;
            for(;;) {
                if (Atomics.compareExchange(metaFromNetCtrl, 0, 0, 1) == 0) {
                    break;
                }
                Atomics.wait(metaFromNetCtrl, 0, 1);
            }
            let end = metaFromNetEnd[0]; //exclusive
            if (end > 0) {
                buf = appendData(buf, metaFromNetData.slice(0, end));
                metaFromNetEnd[0] = 0;
            }
            if (metaFromNetStatus[0] == 1) {
                done = true;
            }
            if (Atomics.compareExchange(metaFromNetCtrl, 0, 1, 0) != 1) {
                console.log("UNEXPECTED STATUS");
            }
            Atomics.notify(metaFromNetCtrl, 0, 1);

            if (done) {
                resolve(buf); // EOF
            } else {
                setTimeout(getCert, 0);
                return;
            }
        }
        getCert();
    });
}

function createStack(stackWorker, stackWasmURL, readyCallback) {
    var proxyShared = new SharedArrayBuffer(12 + 1024 * 1024);

    var toShared = new SharedArrayBuffer(1024 * 1024);
    var fromShared = new SharedArrayBuffer(1024 * 1024);
    var toNetCtrl = new Int32Array(toShared, 0, 1);
    var toNetBegin = new Int32Array(toShared, 4, 1);
    var toNetEnd = new Int32Array(toShared, 8, 1);
    var toNetNotify = new Int32Array(toShared, 12, 1);
    var toNetData = new Uint8Array(toShared, 16);
    var fromNetCtrl = new Int32Array(fromShared, 0, 1);
    var fromNetBegin = new Int32Array(fromShared, 4, 1);
    var fromNetEnd = new Int32Array(fromShared, 8, 1);
    var fromNetData = new Uint8Array(fromShared, 12);
    toNetCtrl[0] = 0;
    toNetBegin[0] = 0;
    toNetEnd[0] = 0;
    toNetNotify[0] = 0;
    fromNetCtrl[0] = 0;
    fromNetBegin[0] = 0;
    fromNetEnd[0] = 0;

    var metaFromShared = new SharedArrayBuffer(4096);
    var metaFromNetCtrl = new Int32Array(metaFromShared, 0, 1);
    var metaFromNetBegin = new Int32Array(metaFromShared, 4, 1);
    var metaFromNetEnd = new Int32Array(metaFromShared, 8, 1);
    var metaFromNetStatus = new Int32Array(metaFromShared, 12, 1);
    var metaFromNetData = new Uint8Array(metaFromShared, 16);
    metaFromNetCtrl[0] = 0;
    metaFromNetBegin[0] = 0;
    metaFromNetEnd[0] = 0;
    metaFromNetStatus[0] = 0;
    
    var certbuf = {
        buf: new Uint8Array(0),
        readyCallback: readyCallback
    }
    stackWorker.onmessage = connect("proxy", proxyShared, toShared, certbuf);
    stackWorker.postMessage({type: "init", buf: proxyShared, toBuf: toShared, fromBuf: fromShared, stackWasmURL: stackWasmURL, metaFromBuf: metaFromShared});
    return {
        toNet: toShared,
        fromNet: fromShared,
        metaFromNet: metaFromShared
    };
}

function connect(name, shared, toNet, certbuf) {
    var streamCtrl = new Int32Array(shared, 0, 1);
    var streamStatus = new Int32Array(shared, 4, 1);
    var streamLen = new Int32Array(shared, 8, 1);
    var streamData = new Uint8Array(shared, 12);
    var httpConnections = [];
    var curID = 0;
    var maxID = 0x7FFFFFFF; // storable in streamStatus(signed 32bits)
    function getID() {
        var startID = curID;
        while (true) {
            if (httpConnections[curID] == undefined) {
                return curID;
            }
            if (curID >= maxID) {
                curID = 0;
            } else {
                curID++;
            }
            if (curID == startID) {
                return -1; // exhausted
            }
        }
        return curID;
    }
    function serveData(data, len) {
        var length = len;
        if (length > streamData.byteLength)
            length = streamData.byteLength;
        if (length > data.byteLength)
            length = data.byteLength
        var buf = data.subarray(0, length);
        var remain = data.subarray(length, data.byteLength);
        streamLen[0] = buf.byteLength;
        streamData.set(buf, 0);
        return remain;
    }
    function serveDataOffset(data, off, len) {
        var length = len;
        if (length > streamData.byteLength)
            length = streamData.byteLength;
        if (off + length > data.byteLength)
            length = data.byteLength - off
        var buf = data.subarray(off, off + length);
        streamLen[0] = buf.byteLength;
        streamData.set(buf, 0);
        return;
    }

    // Keep only a bounded amount of each response in memory. The guest's
    // http_readbody calls drain these chunks while the upstream reader pauses
    // automatically when the queue reaches the high-water mark.
    const MAX_RESPONSE_BUFFER_BYTES = 1024 * 1024;

    function queueResponseChunk(connObj, chunk) {
        if (!chunk || chunk.byteLength === 0) return;
        connObj.respBodyChunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        connObj.respBodyBytes += chunk.byteLength;
    }

    function serveResponseChunks(connObj, requestedLength) {
        const limit = Math.min(
            streamData.byteLength,
            Math.max(0, Number(requestedLength) || 0)
        );
        let written = 0;

        while (written < limit && connObj.respBodyChunks.length > 0) {
            const chunk = connObj.respBodyChunks[0];
            const offset = connObj.respBodyOffset || 0;
            const count = Math.min(limit - written, chunk.byteLength - offset);

            if (count <= 0) {
                connObj.respBodyChunks.shift();
                connObj.respBodyOffset = 0;
                continue;
            }

            streamData.set(chunk.subarray(offset, offset + count), written);
            written += count;
            connObj.respBodyBytes -= count;
            connObj.respBodyOffset = offset + count;

            if (connObj.respBodyOffset >= chunk.byteLength) {
                connObj.respBodyChunks.shift();
                connObj.respBodyOffset = 0;
            }
        }

        streamLen[0] = written;
        return written;
    }

    function joinChunks(chunks, totalLength) {
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result;
    }

    function makeResponseMetadata(resp, address) {
        const headers = {};
        for (const key of resp.headers.keys()) {
            // Fetch may transparently decompress upstream content. Forwarding
            // its original encoding/length would make the guest parse a false
            // length or try to decompress bytes that are already decoded.
            if (key.toLowerCase() === "content-encoding" ||
                key.toLowerCase() === "content-length") {
                continue;
            }
            headers[key] = resp.headers.get(key);
        }
        return new TextEncoder().encode(JSON.stringify({
            bodyUsed: resp.bodyUsed,
            headers,
            redirected: resp.redirected,
            status: resp.status,
            statusText: resp.statusText,
            type: resp.type,
            url: resp.url || address
        }));
    }

    async function pumpResponseBody(id, connObj) {
        const reader = connObj.respReader;
        try {
            while (httpConnections[id] === connObj) {
                // Backpressure: do not read another upstream chunk while the
                // guest has not drained the bounded queue.
                while (connObj.respBodyBytes >= MAX_RESPONSE_BUFFER_BYTES &&
                       httpConnections[id] === connObj) {
                    await new Promise(resolve => setTimeout(resolve, 4));
                }

                if (httpConnections[id] !== connObj) {
                    try { await reader.cancel(); } catch (_) {}
                    return;
                }

                const item = await reader.read();
                if (item.done) {
                    connObj.done = true;
                    connObj.respReader = null;
                    return;
                }
                if (item.value && item.value.byteLength) {
                    queueResponseChunk(connObj, item.value);
                }
            }
        } catch (error) {
            if (httpConnections[id] === connObj) {
                connObj.respError = error;
                connObj.done = true;
                connObj.respReader = null;
                console.error("[WebPC network relay] response stream failed:", connObj.address, error);
            }
        }
    }
    var timeoutHandler = null;
    var timeoutDeadlineMilli = null;
    let toNetCtrl = new Int32Array(toNet, 0, 1);
    let toNetBegin = new Int32Array(toNet, 4, 1);
    let toNetEnd = new Int32Array(toNet, 8, 1);
    let toNetNotify = new Int32Array(toNet, 12, 1);
    let toNetData = new Uint8Array(toNet, 16);
    function isBufReadable() {
        let begin = toNetBegin[0]; //inclusive
        let end = toNetEnd[0]; //exclusive
        var len;
        var round;
        if (end >= begin) {
            len = end - begin;
            round = 0;
        } else {
            len = toNetData.byteLength - begin;
            round = end;
        }
        if ((len + round) > 0) {
            // ready
            return true;
        } else {
            // not ready
            return false;
        }
    }
    return function(msg){
        const req_ = msg.data;
        if (typeof req_ == "object" && req_.type) {
            switch (req_.type) {
                case "recv-is-readable-cancel":
                    if (timeoutHandler) {
                        clearTimeout(timeoutHandler);
                        timeoutHandler = null;
                    }
                    break;
                case "recv-is-readable":
                    if (isBufReadable()) {
                        streamStatus[0] = 1; // ready for reading
                        Atomics.store(toNetNotify, 0, 1);
                        Atomics.notify(toNetNotify, 0);
                    } else {
                        if ((req_.timeout != undefined) && (req_.timeout > 0)) {
                            if (timeoutHandler) {
                                clearTimeout(timeoutHandler);
                                timeoutHandler = null;
                                timeoutDeadlineMilli = null;
                            }
                            timeoutDeadlineMilli = Date.now() + req_.timeout * 1000;
                            function pollBuf() {
                                timeoutHandler = setInterval(() => {
                                    if (isBufReadable()) {
                                        streamStatus[0] = 1; // ready for reading
                                        Atomics.store(toNetNotify, 0, 1);
                                    } else {
                                        if (Date.now() < timeoutDeadlineMilli) {
                                            return; // try again
                                        }
                                        streamStatus[0] = 0; // timeout
                                        Atomics.store(toNetNotify, 0, -1);
                                    }
                                    Atomics.notify(toNetNotify, 0);
                                    clearTimeout(timeoutHandler);
                                    timeoutHandler = null;
                                }, 0.01);
                            }
                            pollBuf();
                        } else {
                            streamStatus[0] = 0; // timeout
                            Atomics.store(toNetNotify, 0, -1);
                            Atomics.notify(toNetNotify, 0);
                        }
                    }
                    break;
                case "notify-send-from-net":
                    sockRecvWS(req_.len);
                    break;
                case "http_send":
                    var reqObj = JSON.parse(new TextDecoder().decode(req_.req));
                    reqObj.mode = "cors";
                    reqObj.credentials = "omit";
                    if (reqObj.headers && reqObj.headers["User-Agent"] != "") {
                        delete reqObj.headers["User-Agent"]; // Browser will add its own value.
                    }
                    var reqID = getID();
                    if (reqID < 0) {
                        console.log(name + ":" + "failed to get id");
                        streamStatus[0] = -1;
                        break;
                    }
                    var connObj = {
                        address: new TextDecoder().decode(req_.address),
                        request: reqObj,
                        requestSent: false,
                        reqBodyChunks: [],
                        reqBodySize: 0,
                        reqBodyEOF: false,

                        response: null,
                        done: false,
                        respBodyChunks: [],
                        respBodyOffset: 0,
                        respBodyBytes: 0,
                        respReader: null,
                        respError: null,
                    };
                    httpConnections[reqID] = connObj;
                    streamStatus[0] = reqID;
                    break;
                case "http_writebody": {
                    const connObj = httpConnections[req_.id];
                    if (!connObj) {
                        streamStatus[0] = -1;
                        break;
                    }

                    if (req_.body && req_.body.byteLength) {
                        const chunk = req_.body instanceof Uint8Array
                            ? req_.body.slice()
                            : new Uint8Array(req_.body);
                        connObj.reqBodyChunks.push(chunk);
                        connObj.reqBodySize += chunk.byteLength;
                    }
                    connObj.reqBodyEOF = req_.isEOF;
                    streamStatus[0] = 0;

                    if (req_.isEOF && !connObj.requestSent) {
                        connObj.requestSent = true;
                        if (connObj.request.method !== "HEAD" &&
                            connObj.request.method !== "GET") {
                            connObj.request.body = joinChunks(
                                connObj.reqBodyChunks,
                                connObj.reqBodySize
                            );
                        }
                        connObj.reqBodyChunks = [];
                        connObj.reqBodySize = 0;

                        fetchWebPCRequest(connObj.address, connObj.request).then((resp) => {
                            // Make status and headers available immediately; body bytes
                            // are streamed separately with bounded memory and backpressure.
                            connObj.response = makeResponseMetadata(resp, connObj.address);
                            connObj.done = false;

                            if (!resp.body) {
                                connObj.done = true;
                                return;
                            }

                            connObj.respReader = resp.body.getReader();
                            pumpResponseBody(req_.id, connObj);
                        }).catch((error) => {
                            const reason = String(
                                error && error.message ? error.message : error
                            ).slice(0, 240);
                            console.error(
                                "[WebPC network relay] request failed:",
                                connObj.address,
                                error
                            );
                            connObj.response = new TextEncoder().encode(JSON.stringify({
                                status: 503,
                                statusText: "WebPC relay fetch failed: " + reason,
                                url: connObj.address
                            }));
                            queueResponseChunk(
                                connObj,
                                new TextEncoder().encode(
                                    "WebPC relay fetch failed for " + connObj.address + ": " + reason + "\n"
                                )
                            );
                            connObj.done = true;
                        });
                    }
                    break;
                }
                case "http_isreadable":
                    if ((httpConnections[req_.id] != undefined) && (httpConnections[req_.id].response != null)) {
                        streamData[0] = 1; // ready for reading
                    } else {
                        streamData[0] = 0; // nothing to read
                    }
                    streamStatus[0] = 0;
                    break;
                case "http_recv":
                    if ((httpConnections[req_.id] == undefined) || (httpConnections[req_.id].response == null)) {
                        console.log(name + ":" + "response is not available");
                        streamStatus[0] = -1;
                        break;
                    }
                    httpConnections[req_.id].response = serveData(httpConnections[req_.id].response, req_.len);
                    streamStatus[0] = 0;
                    if (httpConnections[req_.id].response.byteLength == 0) {
                        streamStatus[0] = 1; // isEOF
                    }
                    break;
                case "http_readbody": {
                    const connObj = httpConnections[req_.id];
                    if (!connObj || connObj.response == null) {
                        console.log(name + ":" + "response body is not available");
                        streamStatus[0] = -1;
                        break;
                    }

                    serveResponseChunks(connObj, req_.len);
                    streamStatus[0] = 0;

                    if (connObj.done && connObj.respBodyBytes === 0) {
                        if (connObj.respError) {
                            // Never report a truncated transfer as clean EOF:
                            // let the guest fail/retry rather than install corrupt bytes.
                            streamStatus[0] = -1;
                        } else {
                            streamStatus[0] = 1;
                        }
                        delete httpConnections[req_.id];
                    }
                    break;
                }
                case "send_cert":
                    certbuf.buf = appendData(certbuf.buf, req_.buf);
                    certbuf.readyCallback(certbuf.buf);
                    streamStatus[0] = 0;
                    break;
                default:
                    console.log(name + ":" + "unknown request: " +  req_.type)
                    return;
            }
            Atomics.store(streamCtrl, 0, 1);
            Atomics.notify(streamCtrl, 0);
        } else {
            console.log("UNKNOWN MSG " + msg);
        }
    }
}

var decompressID = 0;
var decompressors = {};

function appendData(data1, data2) {
    let buf2 = new Uint8Array(data1.byteLength + data2.byteLength);
    buf2.set(new Uint8Array(data1), 0);
    buf2.set(new Uint8Array(data2), data1.byteLength);
    return buf2;
}
