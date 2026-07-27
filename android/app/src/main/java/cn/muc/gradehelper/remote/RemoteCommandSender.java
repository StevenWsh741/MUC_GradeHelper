package cn.muc.gradehelper.remote;

import android.util.Base64;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class RemoteCommandSender {
    private static final String PROTOCOL = "muc-grade-helper-v1";
    private static final SecureRandom RANDOM = new SecureRandom();

    interface Callback {
        void onComplete(Exception error);
    }

    static void sendStart(PairingConfig config, CredentialVault.Credentials credentials, Callback callback) {
        new Thread(() -> {
            Exception failure = null;
            try {
                byte[] ciphertext = encrypt(config, credentials);
                String endpoint = config.endpoint.replaceAll("/$", "") + "/" + config.topic;
                HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
                try {
                    connection.setRequestMethod("POST");
                    connection.setConnectTimeout(20_000);
                    connection.setReadTimeout(20_000);
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
                    connection.setRequestProperty("Title", "MUC encrypted remote command");
                    connection.setRequestProperty("Tags", "lock");
                    connection.setRequestProperty("Priority", "high");
                    connection.setRequestProperty("Cache", "no");
                    connection.setFixedLengthStreamingMode(ciphertext.length);
                    try (OutputStream stream = connection.getOutputStream()) {
                        stream.write(ciphertext);
                    }
                    int status = connection.getResponseCode();
                    try (InputStream stream = status >= 400
                            ? connection.getErrorStream() : connection.getInputStream()) {
                        if (stream != null) while (stream.read() != -1) { }
                    }
                    if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
                } finally {
                    connection.disconnect();
                }
            } catch (Exception error) {
                failure = error;
            }
            callback.onComplete(failure);
        }, "encrypted-start-command").start();
    }

    private static byte[] encrypt(PairingConfig config, CredentialVault.Credentials credentials) throws Exception {
        byte[] nonce = new byte[16];
        byte[] iv = new byte[12];
        RANDOM.nextBytes(nonce);
        RANDOM.nextBytes(iv);
        JSONObject json = new JSONObject();
        json.put("v", 1);
        json.put("timestamp", System.currentTimeMillis());
        json.put("nonce", Base64.encodeToString(nonce, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
        json.put("type", "start_checker");
        json.put("username", credentials.username);
        json.put("password", credentials.password);

        byte[] key = Base64.decode(config.key, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD((PROTOCOL + "|" + config.topic).getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, packed, 0, iv.length);
        System.arraycopy(encrypted, 0, packed, iv.length, encrypted.length);
        return Base64.encode(packed, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
}
