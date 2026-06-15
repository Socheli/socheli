package com.socheli.poster;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;

/** Makes the phone a real fleet node. Connects to the same MQTT broker as the
 *  render devices, publishes retained presence on socheli/workers/<device>/presence
 *  (with a Last-Will so a drop shows "offline"), heartbeats every 20s, reflects live
 *  status (idle/busy + currentJob), and subscribes to socheli/device/<device>/jobs
 *  for MQTT-dispatched post jobs. Mirrors packages/engine/src/agent.ts. */
public final class FleetClient implements MqttWs.Listener {

    public interface JobSink { void onMqttJob(JSONObject job); }

    private final Context ctx;
    private final Prefs prefs;
    private final JobSink sink;
    private final String device, presenceTopic, deviceJobTopic;

    private volatile MqttWs mqtt;
    private volatile boolean running = false;
    private volatile String status = "idle";
    private volatile String currentJob = null;

    public FleetClient(Context ctx, Prefs prefs, JobSink sink) {
        this.ctx = ctx; this.prefs = prefs; this.sink = sink;
        this.device = prefs.deviceId();
        this.presenceTopic = "socheli/workers/" + device + "/presence";
        this.deviceJobTopic = "socheli/device/" + device + "/jobs";
    }

    public void start() {
        if (running) return;
        running = true;
        Thread loop = new Thread(this::connectLoop, "fleet-loop"); loop.setDaemon(true); loop.start();
        Thread hb = new Thread(this::heartbeat, "fleet-hb"); hb.setDaemon(true); hb.start();
    }

    public void stop() {
        running = false;
        MqttWs m = mqtt;
        if (m != null) { setStatus("offline", null); m.disconnect(); }
    }

    public boolean connected() { MqttWs m = mqtt; return m != null && m.isConnected(); }

    /** Update + immediately broadcast what the phone is doing. */
    public void setStatus(String s, String job) {
        status = s; currentJob = job;
        publishPresence();
    }

    private void connectLoop() {
        while (running) {
            String url = prefs.brokerUrl();
            if (url.isEmpty()) { sleep(5000); continue; }
            try {
                MqttWs m = new MqttWs(url, nullIfEmpty(prefs.mqttUser()), nullIfEmpty(prefs.mqttPass()),
                        device + "-" + System.currentTimeMillis(), 30, presenceTopic, offlinePayload(), this);
                mqtt = m;
                m.connect();                       // blocks until CONNACK
                while (running && m.isConnected()) sleep(1000);
            } catch (Exception ignored) { /* fall through to backoff */ }
            mqtt = null;
            if (running) sleep(5000);              // reconnect backoff
        }
    }

    private void heartbeat() {
        while (running) {
            sleep(20_000);
            if (connected()) publishPresence();
        }
    }

    // ── MqttWs.Listener ───────────────────────────────────────────────────────
    @Override public void onConnected() {
        publishPresence();
        try { MqttWs m = mqtt; if (m != null) m.subscribe(deviceJobTopic, 1); } catch (Exception ignored) {}
    }

    @Override public void onMessage(String topic, byte[] payload) {
        if (!topic.equals(deviceJobTopic)) return;
        try {
            JSONObject job = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            if (sink != null) sink.onMqttJob(job);
        } catch (Exception ignored) {}
    }

    @Override public void onClosed(String reason) { /* connectLoop handles reconnect */ }

    // ── presence payloads ─────────────────────────────────────────────────────
    private void publishPresence() {
        MqttWs m = mqtt;
        if (m == null || !m.isConnected()) return;
        try { m.publish(presenceTopic, presencePayload(), 1, true); } catch (Exception ignored) {}
    }

    private byte[] presencePayload() {
        try {
            JSONObject o = new JSONObject();
            o.put("device", device);
            o.put("status", status);
            o.put("host", Build.MODEL == null ? device : Build.MODEL);
            o.put("caps", caps());
            o.put("profile", profile());
            o.put("currentJob", currentJob == null ? JSONObject.NULL : currentJob);
            o.put("lastSeen", iso());
            return o.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) { return offlinePayload(); }
    }

    private byte[] offlinePayload() {
        try {
            JSONObject o = new JSONObject();
            o.put("device", device); o.put("status", "offline"); o.put("lastSeen", iso());
            return o.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) { return ("{\"device\":\"" + device + "\",\"status\":\"offline\"}").getBytes(StandardCharsets.UTF_8); }
    }

    private JSONArray caps() {
        JSONArray a = new JSONArray();
        a.put("publish");
        for (String p : new String[]{"instagram", "tiktok", "youtube"}) {
            String pkg = PostFlows.packageFor(p);
            if (pkg != null && installed(pkg)) a.put("post:" + p);
        }
        return a;
    }

    private JSONObject profile() throws Exception {
        JSONObject p = new JSONObject();
        p.put("arch", (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0) ? Build.SUPPORTED_ABIS[0] : "arm64");
        p.put("platform", "android");
        p.put("cpus", Runtime.getRuntime().availableProcessors());
        p.put("ramGb", ramGb());
        p.put("gpu", "none");
        return p;
    }

    private int ramGb() {
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            return Math.max(1, Math.round(mi.totalMem / 1e9f));
        } catch (Exception e) { return 0; }
    }

    private boolean installed(String pkg) {
        try { ctx.getPackageManager().getPackageInfo(pkg, 0); return true; } catch (Exception e) { return false; }
    }

    private static String iso() { return Instant.now().toString(); }
    private static String nullIfEmpty(String s) { return (s == null || s.isEmpty()) ? null : s; }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
