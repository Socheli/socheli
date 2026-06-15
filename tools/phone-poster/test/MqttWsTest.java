package com.socheli.poster;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** JVM test harness — runs the SAME MqttWs the APK uses, against the live broker.
 *  Reads .env, connects, publishes a phone-test presence, subscribes to the fleet. */
public class MqttWsTest {
    public static void main(String[] args) throws Exception {
        Map<String, String> env = new HashMap<>();
        for (String l : Files.readAllLines(Paths.get(".env"))) {
            int eq = l.indexOf('=');
            if (eq > 0 && !l.trim().startsWith("#")) env.put(l.substring(0, eq).trim(), l.substring(eq + 1).trim().replaceAll("^[\"']|[\"']$", ""));
        }
        String url = env.get("SOCHELI_BROKER_URL");
        String dev = "phone-test";
        String presenceTopic = "socheli/workers/" + dev + "/presence";
        String iso = Instant.now().toString();
        String will = "{\"device\":\"" + dev + "\",\"status\":\"offline\",\"lastSeen\":\"" + iso + "\"}";

        MqttWs c = new MqttWs(url, env.get("SOCHELI_MQTT_USER"), env.get("SOCHELI_MQTT_PASS"),
            "phone-test-" + System.currentTimeMillis(), 30, presenceTopic, will.getBytes(StandardCharsets.UTF_8),
            new MqttWs.Listener() {
                public void onConnected() { System.out.println("CONNECTED ✓ (CONNACK received)"); }
                public void onMessage(String topic, byte[] payload) { System.out.println("MSG " + topic + "  " + new String(payload, StandardCharsets.UTF_8).substring(0, Math.min(90, payload.length))); }
                public void onClosed(String reason) { System.out.println("CLOSED: " + reason); }
            });

        c.connect();
        String online = "{\"device\":\"" + dev + "\",\"status\":\"idle\",\"host\":\"Pixel-test\",\"caps\":[\"post:instagram\",\"post:tiktok\"],"
            + "\"profile\":{\"arch\":\"arm64\",\"platform\":\"android\",\"cpus\":8,\"ramGb\":8,\"gpu\":\"none\"},\"currentJob\":null,\"lastSeen\":\"" + iso + "\"}";
        c.publish(presenceTopic, online.getBytes(StandardCharsets.UTF_8), 1, true);
        System.out.println("published presence → " + presenceTopic);
        c.subscribe("socheli/workers/+/presence", 1);
        System.out.println("subscribed socheli/workers/+/presence — listening 4s…");
        Thread.sleep(4000);
        // leave a clean offline state behind so the test device doesn't linger as online
        c.publish(presenceTopic, will.getBytes(StandardCharsets.UTF_8), 1, true);
        Thread.sleep(300);
        c.disconnect();
        System.out.println("done");
    }
}
