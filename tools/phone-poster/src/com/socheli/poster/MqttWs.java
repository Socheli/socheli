package com.socheli.poster;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLSocketFactory;

/** Minimal MQTT 3.1.1 client over WebSocket (RFC 6455) over TLS — zero dependencies,
 *  pure java + javax.net.ssl, so it compiles for Android AND runs on the JVM (for
 *  off-device testing). Supports CONNECT (user/pass + Last-Will), PUBLISH (qos0/1,
 *  retain), SUBSCRIBE, keepalive PINGREQ, and inbound PUBLISH dispatch. Just enough
 *  to be a real fleet node, not a full broker-grade client. */
public final class MqttWs {

    public interface Listener {
        void onConnected();
        void onMessage(String topic, byte[] payload);
        void onClosed(String reason);
    }

    private final String host, path;
    private final int port;
    private final boolean tls;
    private final String user, pass, clientId;
    private final int keepAliveSec;
    private final String willTopic;
    private final byte[] willPayload;
    private final Listener listener;

    private Socket sock;
    private InputStream in;
    private OutputStream out;
    private final Object writeLock = new Object();
    private final SecureRandom rnd = new SecureRandom();
    private volatile boolean open = false;
    private int packetId = 1;
    private CountDownLatch connackLatch;

    private final byte[] inBuf = new byte[1 << 16];
    private final ByteArrayOutputStream mqttBuf = new ByteArrayOutputStream();

    public MqttWs(String url, String user, String pass, String clientId, int keepAliveSec,
                  String willTopic, byte[] willPayload, Listener listener) {
        // url: wss://host[:port][/path]  | ws://...
        boolean secure = url.startsWith("wss://");
        String rest = url.replaceFirst("^wss?://", "");
        String hostPort, p = "/";
        int slash = rest.indexOf('/');
        if (slash >= 0) { hostPort = rest.substring(0, slash); p = rest.substring(slash); }
        else hostPort = rest;
        int colon = hostPort.indexOf(':');
        if (colon >= 0) { this.host = hostPort.substring(0, colon); this.port = Integer.parseInt(hostPort.substring(colon + 1)); }
        else { this.host = hostPort; this.port = secure ? 443 : 80; }
        this.tls = secure;
        this.path = p.isEmpty() ? "/" : p;
        this.user = user; this.pass = pass; this.clientId = clientId;
        this.keepAliveSec = keepAliveSec;
        this.willTopic = willTopic; this.willPayload = willPayload;
        this.listener = listener;
    }

    public boolean isConnected() { return open; }

    /** Blocking connect: TLS → WebSocket upgrade → MQTT CONNECT → await CONNACK. */
    public void connect() throws IOException {
        sock = tls ? SSLSocketFactory.getDefault().createSocket(host, port) : new Socket(host, port);
        sock.setTcpNoDelay(true);
        in = sock.getInputStream();
        out = sock.getOutputStream();
        wsHandshake();
        connackLatch = new CountDownLatch(1);
        Thread reader = new Thread(this::readLoop, "mqtt-reader");
        reader.setDaemon(true);
        reader.start();
        sendConnect();
        try {
            if (!connackLatch.await(15, TimeUnit.SECONDS)) throw new IOException("no CONNACK");
        } catch (InterruptedException e) { throw new IOException("interrupted"); }
        startPinger();
    }

    // ── WebSocket handshake ──────────────────────────────────────────────────
    private void wsHandshake() throws IOException {
        byte[] key = new byte[16]; rnd.nextBytes(key);
        String secKey = Base64.getEncoder().encodeToString(key);
        String req = "GET " + path + " HTTP/1.1\r\n" +
                "Host: " + host + "\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: " + secKey + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "Sec-WebSocket-Protocol: mqtt\r\n\r\n";
        out.write(req.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = readLine();
        if (status == null || !status.contains(" 101")) throw new IOException("ws upgrade failed: " + status);
        String line;
        while ((line = readLine()) != null && !line.isEmpty()) { /* drain headers */ }
    }

    private String readLine() throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c, prev = -1;
        while ((c = in.read()) != -1) {
            if (prev == '\r' && c == '\n') { byte[] a = b.toByteArray(); return new String(a, 0, a.length - 1, StandardCharsets.US_ASCII); }
            b.write(c); prev = c;
        }
        return null;
    }

    // ── WebSocket framing (client frames are masked binary) ───────────────────
    private void writeWs(byte[] data) throws IOException {
        synchronized (writeLock) {
            ByteArrayOutputStream f = new ByteArrayOutputStream();
            f.write(0x82); // FIN + binary
            int len = data.length;
            if (len < 126) f.write(0x80 | len);
            else if (len < 65536) { f.write(0x80 | 126); f.write((len >> 8) & 0xFF); f.write(len & 0xFF); }
            else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) len >> (8 * i)) & 0xFF)); }
            byte[] mask = new byte[4]; rnd.nextBytes(mask);
            f.write(mask, 0, 4);
            byte[] masked = new byte[len];
            for (int i = 0; i < len; i++) masked[i] = (byte) (data[i] ^ mask[i & 3]);
            f.write(masked, 0, len);
            out.write(f.toByteArray());
            out.flush();
        }
    }

    private void readLoop() {
        try {
            while (true) {
                int b0 = in.read();
                if (b0 < 0) break;
                int opcode = b0 & 0x0F;
                int b1 = in.read();
                if (b1 < 0) break;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) len = (read1() << 8) | read1();
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | read1(); }
                byte[] mask = masked ? readN(4) : null;
                byte[] payload = readN((int) len);
                if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

                if (opcode == 0x8) break;                 // close
                else if (opcode == 0x9) writePong(payload); // ping → pong
                else if (opcode == 0xA) { /* pong */ }
                else { mqttBuf.write(payload); parseMqtt(); } // 0x1/0x2/0x0 data
            }
        } catch (IOException e) {
            close("read: " + e.getMessage());
            return;
        }
        close("stream ended");
    }

    private void writePong(byte[] payload) throws IOException {
        synchronized (writeLock) {
            ByteArrayOutputStream f = new ByteArrayOutputStream();
            f.write(0x8A); // FIN + pong
            byte[] mask = new byte[4]; rnd.nextBytes(mask);
            int len = payload.length;
            f.write(0x80 | (len < 126 ? len : 0)); // pong payloads are tiny
            f.write(mask, 0, 4);
            for (int i = 0; i < len; i++) f.write(payload[i] ^ mask[i & 3]);
            out.write(f.toByteArray()); out.flush();
        }
    }

    private int read1() throws IOException { int c = in.read(); if (c < 0) throw new IOException("eof"); return c; }
    private byte[] readN(int n) throws IOException {
        byte[] b = new byte[n]; int off = 0;
        while (off < n) { int r = in.read(b, off, n - off); if (r < 0) throw new IOException("eof"); off += r; }
        return b;
    }

    // ── MQTT packet parse out of the rolling buffer ──────────────────────────
    private void parseMqtt() {
        byte[] buf = mqttBuf.toByteArray();
        int pos = 0;
        while (pos + 2 <= buf.length) {
            int type = (buf[pos] & 0xF0) >> 4;
            int flags = buf[pos] & 0x0F;
            // decode remaining length varint
            int mult = 1, rem = 0, i = pos + 1, lenBytes = 0;
            int enc;
            do {
                if (i >= buf.length) return; // incomplete
                enc = buf[i] & 0xFF; rem += (enc & 127) * mult; mult *= 128; i++; lenBytes++;
                if (lenBytes > 4) return;
            } while ((enc & 128) != 0);
            int total = 1 + lenBytes + rem;
            if (pos + total > buf.length) return; // wait for more bytes
            int vpos = pos + 1 + lenBytes;
            handlePacket(type, flags, buf, vpos, rem);
            pos += total;
        }
        // keep any unparsed tail
        mqttBuf.reset();
        if (pos < buf.length) mqttBuf.write(buf, pos, buf.length - pos);
    }

    private void handlePacket(int type, int flags, byte[] b, int p, int rem) {
        switch (type) {
            case 2: // CONNACK
                if (connackLatch != null) connackLatch.countDown();
                open = true;
                if (listener != null) listener.onConnected();
                break;
            case 3: { // PUBLISH
                int qos = (flags >> 1) & 3;
                int tlen = ((b[p] & 0xFF) << 8) | (b[p + 1] & 0xFF);
                String topic = new String(b, p + 2, tlen, StandardCharsets.UTF_8);
                int q = p + 2 + tlen;
                int pid = 0;
                if (qos > 0) { pid = ((b[q] & 0xFF) << 8) | (b[q + 1] & 0xFF); q += 2; }
                int plen = (p + rem) - q;
                byte[] payload = new byte[plen];
                System.arraycopy(b, q, payload, 0, plen);
                if (qos == 1) try { sendPuback(pid); } catch (IOException ignored) {}
                if (listener != null) listener.onMessage(topic, payload);
                break;
            }
            default: /* PUBACK(4) SUBACK(9) PINGRESP(13) — nothing to do */ break;
        }
    }

    // ── MQTT writers ──────────────────────────────────────────────────────────
    private void sendConnect() throws IOException {
        ByteArrayOutputStream vh = new ByteArrayOutputStream();
        writeStr(vh, "MQTT");
        vh.write(0x04); // protocol level 3.1.1
        int flags = 0x02; // clean session
        if (user != null) flags |= 0x80;
        if (pass != null) flags |= 0x40;
        boolean will = willTopic != null && willPayload != null;
        if (will) flags |= 0x04 | 0x20; // will flag + will retain (qos 0)
        vh.write(flags);
        vh.write((keepAliveSec >> 8) & 0xFF); vh.write(keepAliveSec & 0xFF);
        ByteArrayOutputStream pl = new ByteArrayOutputStream();
        writeStr(pl, clientId);
        if (will) { writeStr(pl, willTopic); writeBytes(pl, willPayload); }
        if (user != null) writeStr(pl, user);
        if (pass != null) writeStr(pl, pass);
        sendPacket(0x10, vh, pl);
    }

    public void publish(String topic, byte[] payload, int qos, boolean retain) throws IOException {
        ByteArrayOutputStream vh = new ByteArrayOutputStream();
        writeStr(vh, topic);
        if (qos > 0) { int id = nextId(); vh.write((id >> 8) & 0xFF); vh.write(id & 0xFF); }
        ByteArrayOutputStream pl = new ByteArrayOutputStream();
        pl.write(payload, 0, payload.length); // PUBLISH payload is raw — NOT length-prefixed
        int header = 0x30 | (qos << 1) | (retain ? 1 : 0);
        sendPacket(header, vh, pl);
    }

    public void subscribe(String topic, int qos) throws IOException {
        ByteArrayOutputStream vh = new ByteArrayOutputStream();
        int id = nextId(); vh.write((id >> 8) & 0xFF); vh.write(id & 0xFF);
        ByteArrayOutputStream pl = new ByteArrayOutputStream();
        writeStr(pl, topic); pl.write(qos);
        sendPacket(0x82, vh, pl);
    }

    private void sendPuback(int pid) throws IOException {
        byte[] pkt = new byte[]{0x40, 0x02, (byte) ((pid >> 8) & 0xFF), (byte) (pid & 0xFF)};
        writeWs(pkt);
    }

    private void startPinger() {
        Thread t = new Thread(() -> {
            try {
                while (open) {
                    Thread.sleep(Math.max(5, keepAliveSec / 2) * 1000L);
                    if (!open) break;
                    writeWs(new byte[]{(byte) 0xC0, 0x00}); // PINGREQ
                }
            } catch (Exception e) { close("ping: " + e.getMessage()); }
        }, "mqtt-ping");
        t.setDaemon(true); t.start();
    }

    public void disconnect() {
        try { if (open) writeWs(new byte[]{(byte) 0xE0, 0x00}); } catch (IOException ignored) {}
        close("client disconnect");
    }

    private void close(String reason) {
        open = false;
        try { if (sock != null) sock.close(); } catch (IOException ignored) {}
        if (listener != null) listener.onClosed(reason);
    }

    // ── encoding helpers ──────────────────────────────────────────────────────
    private void sendPacket(int header, ByteArrayOutputStream vh, ByteArrayOutputStream pl) throws IOException {
        byte[] body = new byte[vh.size() + pl.size()];
        System.arraycopy(vh.toByteArray(), 0, body, 0, vh.size());
        System.arraycopy(pl.toByteArray(), 0, body, vh.size(), pl.size());
        ByteArrayOutputStream pkt = new ByteArrayOutputStream();
        pkt.write(header);
        int len = body.length;
        do { int enc = len % 128; len /= 128; if (len > 0) enc |= 128; pkt.write(enc); } while (len > 0);
        pkt.write(body, 0, body.length);
        writeWs(pkt.toByteArray());
    }
    private static void writeStr(ByteArrayOutputStream o, String s) { writeBytes(o, s.getBytes(StandardCharsets.UTF_8)); }
    private static void writeBytes(ByteArrayOutputStream o, byte[] b) { o.write((b.length >> 8) & 0xFF); o.write(b.length & 0xFF); o.write(b, 0, b.length); }
    private synchronized int nextId() { packetId = packetId >= 65535 ? 1 : packetId + 1; return packetId; }
}
