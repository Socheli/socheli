package com.socheli.poster;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** Minimal settings + control screen, built in code (no layout XML, no AndroidX).
 *  Set the server URL + device id, grant Accessibility, arm, and start the service. */
public final class MainActivity extends Activity {
    private Prefs prefs;
    private EditText urlField, deviceField, brokerField, mqttUserField, mqttPassField;
    private Switch armSwitch;
    private TextView status;

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        prefs = new Prefs(this);

        // headless provisioning (adb / fleet onboarding):
        //   am start -n com.socheli.poster/.MainActivity --es broker wss://… --es mqtt_user m4 \
        //            --es mqtt_pass … --es device phone-x --ez arm true --ez start true
        Bundle ex = getIntent().getExtras();
        if (ex != null) {
            if (ex.containsKey("server")) prefs.set(Prefs.BASE_URL, ex.getString("server"));
            if (ex.containsKey("broker")) prefs.set(Prefs.BROKER_URL, ex.getString("broker"));
            if (ex.containsKey("mqtt_user")) prefs.set(Prefs.MQTT_USER, ex.getString("mqtt_user"));
            if (ex.containsKey("mqtt_pass")) prefs.set(Prefs.MQTT_PASS, ex.getString("mqtt_pass"));
            if (ex.containsKey("device")) prefs.set(Prefs.DEVICE_ID, ex.getString("device"));
            if (ex.containsKey("arm")) prefs.set(Prefs.ENABLED, ex.getBoolean("arm"));
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        root.addView(header("Socheli Poster"));
        root.addView(label("Server base URL (e.g. https://api.socheli.com)"));
        urlField = new EditText(this);
        urlField.setHint("https://api.socheli.com");
        urlField.setText(prefs.baseUrl());
        urlField.setSingleLine(true);
        root.addView(urlField);

        root.addView(label("Device id (fleet identity)"));
        deviceField = new EditText(this);
        deviceField.setText(prefs.deviceId());
        deviceField.setSingleLine(true);
        root.addView(deviceField);

        root.addView(label("MQTT broker (wss://mqtt.socheli.com) — fleet presence + control"));
        brokerField = new EditText(this);
        brokerField.setHint("wss://mqtt.socheli.com");
        brokerField.setText(prefs.brokerUrl());
        brokerField.setSingleLine(true);
        root.addView(brokerField);

        root.addView(label("MQTT username"));
        mqttUserField = new EditText(this);
        mqttUserField.setText(prefs.mqttUser());
        mqttUserField.setSingleLine(true);
        root.addView(mqttUserField);

        root.addView(label("MQTT password"));
        mqttPassField = new EditText(this);
        mqttPassField.setText(prefs.mqttPass());
        mqttPassField.setSingleLine(true);
        mqttPassField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(mqttPassField);

        armSwitch = new Switch(this);
        armSwitch.setText("  Armed (pull + post jobs)");
        armSwitch.setChecked(prefs.enabled());
        LinearLayout.LayoutParams sw = new LinearLayout.LayoutParams(-1, -2);
        sw.topMargin = dp(16);
        root.addView(armSwitch, sw);

        root.addView(button("Save", v -> save()));
        root.addView(button("Grant Accessibility access", v ->
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
        root.addView(button("Start service", v -> { save(); startService(); }));
        root.addView(button("Refresh status", v -> refresh()));

        status = new TextView(this);
        status.setPadding(0, dp(18), 0, 0);
        root.addView(status);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);

        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
        if (ex != null && ex.getBoolean("start", false)) startService();
        refresh();
    }

    private void save() {
        prefs.set(Prefs.BASE_URL, urlField.getText().toString().trim());
        prefs.set(Prefs.DEVICE_ID, deviceField.getText().toString().trim());
        prefs.set(Prefs.BROKER_URL, brokerField.getText().toString().trim());
        prefs.set(Prefs.MQTT_USER, mqttUserField.getText().toString().trim());
        prefs.set(Prefs.MQTT_PASS, mqttPassField.getText().toString());
        prefs.set(Prefs.ENABLED, armSwitch.isChecked());
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
        refresh();
    }

    private void startService() {
        Intent i = new Intent(this, PosterService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        Toast.makeText(this, "Service started", Toast.LENGTH_SHORT).show();
        refresh();
    }

    private void refresh() {
        boolean acc = PostAccessibilityService.isEnabled(this);
        status.setText(
            "Accessibility: " + (acc ? "ENABLED ✓" : "NOT enabled — tap 'Grant Accessibility access'") + "\n" +
            "Armed: " + (prefs.enabled() ? "yes" : "no") + "\n" +
            "Server: " + (prefs.baseUrl().isEmpty() ? "(not set)" : prefs.baseUrl()) + "\n" +
            "MQTT broker: " + (prefs.brokerUrl().isEmpty() ? "(not set)" : prefs.brokerUrl()) + (prefs.mqttUser().isEmpty() ? "" : " as " + prefs.mqttUser()) + "\n" +
            "Device: " + prefs.deviceId() + "\n" +
            "Poll: every " + prefs.pollSeconds() + "s\n\n" +
            "Fleet presence → socheli/workers/{device}/presence (live status on /devices).\n" +
            "Jobs: MQTT socheli/device/{device}/jobs, or HTTP {server}/api/phone/jobs.");
    }

    private TextView header(String t) { TextView v = new TextView(this); v.setText(t); v.setTextSize(22); v.setPadding(0, 0, 0, dp(8)); return v; }
    private TextView label(String t) { TextView v = new TextView(this); v.setText(t); v.setPadding(0, dp(14), 0, dp(2)); return v; }
    private Button button(String t, View.OnClickListener cl) {
        Button b = new Button(this); b.setText(t); b.setOnClickListener(cl);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(8); b.setLayoutParams(lp); return b;
    }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
