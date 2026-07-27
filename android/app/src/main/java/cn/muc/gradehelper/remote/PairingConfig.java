package cn.muc.gradehelper.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class PairingConfig {
    static final String PREFS = "private_pairing";
    private static final String PREFIX = "mucgrade-v1:";
    private static final String KEY_ALIAS = "muc_grade_pairing_key";

    final String endpoint;
    final String topic;
    final String key;

    PairingConfig(String endpoint, String topic, String key) {
        this.endpoint = endpoint;
        this.topic = topic;
        this.key = key;
    }

    static PairingConfig parse(String code) throws Exception {
        String trimmed = code == null ? "" : code.trim();
        if (!trimmed.startsWith(PREFIX)) throw new IllegalArgumentException("配对码格式不正确");
        String encoded = trimmed.substring(PREFIX.length());
        byte[] jsonBytes = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        JSONObject json = new JSONObject(new String(jsonBytes, StandardCharsets.UTF_8));
        PairingConfig config = new PairingConfig(
                json.optString("endpoint", ""),
                json.optString("topic", ""),
                json.optString("key", "")
        );
        config.validate();
        return config;
    }

    static PairingConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            String sealed = prefs.getString("sealed", "");
            byte[] packed = Base64.decode(sealed, Base64.NO_WRAP);
            if (packed.length < 29) return null;
            byte[] iv = new byte[12];
            byte[] ciphertext = new byte[packed.length - iv.length];
            System.arraycopy(packed, 0, iv, 0, iv.length);
            System.arraycopy(packed, iv.length, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateStorageKey(), new GCMParameterSpec(128, iv));
            JSONObject json = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            PairingConfig config = new PairingConfig(
                    json.optString("endpoint", ""),
                    json.optString("topic", ""),
                    json.optString("key", "")
            );
            config.validate();
            return config;
        } catch (Exception ignored) {
            return null;
        }
    }

    void save(Context context) throws Exception {
        JSONObject json = new JSONObject();
        json.put("endpoint", endpoint);
        json.put("topic", topic);
        json.put("key", key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateStorageKey());
        byte[] ciphertext = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[cipher.getIV().length + ciphertext.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length);
        System.arraycopy(ciphertext, 0, packed, cipher.getIV().length, ciphertext.length);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("sealed", Base64.encodeToString(packed, Base64.NO_WRAP))
                .putBoolean("enabled", true)
                .apply();
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            keyStore.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
        }
    }

    static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false);
    }

    static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply();
    }

    static String getLastRelayId(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last_relay_id", "");
    }

    static void setLastRelayId(Context context, String relayId) {
        if (relayId != null && relayId.matches("[a-zA-Z0-9_-]{4,128}")) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("last_relay_id", relayId)
                    .apply();
        }
    }

    static String getLastMessageNonce(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("last_message_nonce", "");
    }

    static void setLastMessageNonce(Context context, String nonce) {
        if (nonce != null && nonce.matches("[a-zA-Z0-9_-]{12,128}")) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("last_message_nonce", nonce)
                    .apply();
        }
    }

    private void validate() throws Exception {
        if (!endpoint.startsWith("https://")) throw new IllegalArgumentException("中转地址必须使用 HTTPS");
        if (!topic.matches("[a-zA-Z0-9_-]{16,128}")) throw new IllegalArgumentException("私密频道无效");
        byte[] keyBytes = Base64.decode(key, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (keyBytes.length != 32) throw new IllegalArgumentException("加密密钥无效");
    }

    private static SecretKey getOrCreateStorageKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
