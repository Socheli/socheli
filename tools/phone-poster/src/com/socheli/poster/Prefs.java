package com.socheli.poster;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

/** Tiny settings store: where to pull jobs, this device's id, poll cadence, arm switch. */
public final class Prefs {
    private static final String FILE = "socheli_poster";
    public static final String BASE_URL = "base_url";   // e.g. https://api.socheli.com
    public static final String DEVICE_ID = "device_id"; // identifies this phone in the fleet
    public static final String POLL_SECONDS = "poll_seconds";
    public static final String ENABLED = "enabled";
    public static final String BROKER_URL = "broker_url";   // wss://mqtt.socheli.com
    public static final String MQTT_USER = "mqtt_user";
    public static final String MQTT_PASS = "mqtt_pass";

    private final SharedPreferences sp;

    public Prefs(Context c) { sp = c.getSharedPreferences(FILE, Context.MODE_PRIVATE); }

    public String baseUrl() { return sp.getString(BASE_URL, "").trim(); }
    public String brokerUrl() { return sp.getString(BROKER_URL, "").trim(); }
    public String mqttUser() { return sp.getString(MQTT_USER, "").trim(); }
    public String mqttPass() { return sp.getString(MQTT_PASS, ""); }
    public String deviceId() {
        String d = sp.getString(DEVICE_ID, "");
        if (d == null || d.isEmpty()) d = ("phone-" + Build.MODEL).replaceAll("[^A-Za-z0-9_-]", "-").toLowerCase();
        return d;
    }
    public int pollSeconds() { return Math.max(10, sp.getInt(POLL_SECONDS, 20)); }
    public boolean enabled() { return sp.getBoolean(ENABLED, false); }

    public void set(String key, String v) { sp.edit().putString(key, v).apply(); }
    public void set(String key, boolean v) { sp.edit().putBoolean(key, v).apply(); }
    public void setInt(String key, int v) { sp.edit().putInt(key, v).apply(); }
}
