package com.socheli.poster;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Plain HttpURLConnection networking — no third-party deps.
 *  Job contract:
 *    GET  {base}/api/phone/jobs?device={id}  -> {"jobs":[{id,platform,caption,title,firstComment,mediaUrl}]}
 *    POST {base}/api/phone/result            <- {device,id,platform,status,message}
 */
public final class Net {
    private static final int TIMEOUT = 30000;

    public static List<PostJob> fetchJobs(String base, String device) throws Exception {
        String url = trim(base) + "/api/phone/jobs?device=" + enc(device);
        String body = get(url);
        List<PostJob> out = new ArrayList<>();
        JSONObject o = new JSONObject(body);
        JSONArray arr = o.optJSONArray("jobs");
        if (arr != null) for (int i = 0; i < arr.length(); i++) {
            PostJob j = PostJob.from(arr.getJSONObject(i));
            if (j.valid()) out.add(j);
        }
        return out;
    }

    public static void reportResult(String base, String device, PostJob job, String status, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("device", device); o.put("id", job.id); o.put("platform", job.platform);
            o.put("status", status); o.put("message", message == null ? "" : message);
            postJson(trim(base) + "/api/phone/result", o.toString());
        } catch (Exception ignored) { /* best-effort telemetry */ }
    }

    public static File download(String mediaUrl, File dest) throws Exception {
        HttpURLConnection c = open(mediaUrl);
        c.setRequestMethod("GET");
        int code = c.getResponseCode();
        if (code / 100 != 2) throw new Exception("download HTTP " + code);
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally { c.disconnect(); }
        return dest;
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = open(url);
        c.setRequestMethod("GET");
        c.setRequestProperty("Accept", "application/json");
        return readBody(c);
    }

    private static String postJson(String url, String json) throws Exception {
        HttpURLConnection c = open(url);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = c.getOutputStream()) { os.write(json.getBytes(StandardCharsets.UTF_8)); }
        return readBody(c);
    }

    private static String readBody(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code / 100 == 2 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (in != null) { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); }
        c.disconnect();
        if (code / 100 != 2) throw new Exception("HTTP " + code + ": " + bo.toString("UTF-8"));
        return bo.toString("UTF-8");
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT);
        c.setReadTimeout(TIMEOUT);
        c.setInstanceFollowRedirects(true);
        return c;
    }

    private static String enc(String s) { return s == null ? "" : s.replace(" ", "%20"); }
    private static String trim(String s) { return s.endsWith("/") ? s.substring(0, s.length() - 1) : s; }
}
