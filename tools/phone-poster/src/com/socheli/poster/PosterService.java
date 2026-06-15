package com.socheli.poster;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Foreground service: every pollSeconds, pull jobs, and for each one
 *  download → stage into the gallery → hand to the app → wait for the
 *  accessibility flow → report the result. One post at a time. */
public final class PosterService extends Service {
    public static final String TAG = "SocheliPoster";
    private static final String CHANNEL = "socheli_poster";
    private static final long POST_TIMEOUT_MS = 210_000; // hard cap per post

    private volatile boolean running = false;
    private Thread worker;
    private FleetClient fleet;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, buildNotification("idle"));
        if (!running) { running = true; worker = new Thread(this::loop, "poster-loop"); worker.start(); }
        if (fleet == null) {
            Prefs p = new Prefs(this);
            if (!p.brokerUrl().isEmpty()) { fleet = new FleetClient(this, p, this::onMqttJob); fleet.start(); }
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        if (fleet != null) fleet.stop();
        super.onDestroy();
    }

    /** A post job pushed over MQTT (socheli/device/<id>/jobs) → run it on a worker. */
    private void onMqttJob(org.json.JSONObject json) {
        final PostJob job = PostJob.from(json);
        if (!job.valid()) return;
        new Thread(() -> process(new Prefs(this), job), "mqtt-job").start();
    }

    private void loop() {
        Prefs prefs = new Prefs(this);
        while (running) {
            try {
                if (prefs.enabled() && !prefs.baseUrl().isEmpty()) {
                    List<PostJob> jobs = Net.fetchJobs(prefs.baseUrl(), prefs.deviceId());
                    if (!jobs.isEmpty()) {
                        note("posting " + jobs.size() + " job(s)");
                        for (PostJob j : jobs) { if (!running) break; process(prefs, j); }
                    } else { note("idle — no jobs"); }
                } else { note(prefs.enabled() ? "no server url set" : "disarmed"); }
            } catch (Exception e) {
                Log.w(TAG, "poll error: " + e.getMessage());
                note("poll error: " + safe(e.getMessage()));
            }
            sleep(prefs.pollSeconds() * 1000L);
        }
    }

    private void process(Prefs prefs, PostJob job) {
        String pkg = PostFlows.packageFor(job.platform);
        if (pkg == null) { Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, "skipped", "unknown platform"); return; }
        if (!appInstalled(pkg)) { Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, "skipped", job.platform + " app not installed"); return; }
        if (!PostAccessibilityService.isEnabled(this)) {
            Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, "failed", "accessibility service not enabled");
            return;
        }
        File tmp = null;
        Uri media = null;
        if (fleet != null) fleet.setStatus("busy", job.id);
        try {
            note("downloading " + job.id);
            tmp = Net.download(job.mediaUrl, new File(getCacheDir(), job.id + ".mp4"));
            media = stageToGallery(tmp, job.id);
            if (media == null) throw new Exception("could not stage video into gallery");

            // hand the video to the app, then arm the accessibility flow
            ActivePost ap = new ActivePost(job.platform, job.caption, pkg, PostFlows.flowFor(job.platform));
            ActivePost.current = ap;
            note("posting " + job.id + " → " + job.platform);
            launchShare(pkg, media, job.caption);

            boolean done = ap.latch.await(POST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (!done) { ActivePost.current = null; Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, "failed", "timed out driving " + job.platform); }
            else { Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, ap.status, ap.message); }
        } catch (Exception e) {
            ActivePost.current = null;
            Net.reportResult(prefs.baseUrl(), prefs.deviceId(), job, "failed", safe(e.getMessage()));
        } finally {
            if (tmp != null) tmp.delete();
            if (fleet != null) fleet.setStatus("idle", null);
        }
    }

    /** Insert the mp4 into MediaStore (Movies/Socheli) so the social app's picker sees it. */
    private Uri stageToGallery(File src, String id) throws Exception {
        ContentResolver cr = getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Video.Media.DISPLAY_NAME, id + ".mp4");
        v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        if (Build.VERSION.SDK_INT >= 29) {
            v.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Socheli");
            v.put(MediaStore.Video.Media.IS_PENDING, 1);
        }
        Uri uri = cr.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) return null;
        try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
            byte[] b = new byte[1 << 16]; int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            v.clear(); v.put(MediaStore.Video.Media.IS_PENDING, 0);
            cr.update(uri, v, null, null);
        }
        return uri;
    }

    private void launchShare(String pkg, Uri media, String caption) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("video/mp4");
        send.putExtra(Intent.EXTRA_STREAM, media);
        if (caption != null) send.putExtra(Intent.EXTRA_TEXT, caption);
        send.setPackage(pkg);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(send);
    }

    private boolean appInstalled(String pkg) {
        try { getPackageManager().getPackageInfo(pkg, 0); return true; } catch (Exception e) { return false; }
    }

    // ── notification plumbing ────────────────────────────────────────────────
    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Socheli Poster", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("Socheli Poster").setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload).setOngoing(true).build();
    }
    private void note(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(1, buildNotification(text));
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
    private static String safe(String s) { return s == null ? "error" : (s.length() > 140 ? s.substring(0, 140) : s); }
}
