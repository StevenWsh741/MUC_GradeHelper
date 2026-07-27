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

final class CredentialVault {
    private static final String PREFS = "encrypted_school_credentials";
    private static final String KEY_ALIAS = "muc_grade_credentials_key";

    static final class Credentials {
        final String username;
        final String password;

        Credentials(String username, String password) {
            this.username = username;
            this.password = password;
        }
    }

    static void save(Context context, String username, String password) throws Exception {
        String cleanUsername = username == null ? "" : username.trim();
        if (cleanUsername.isEmpty() || cleanUsername.length() > 100) {
            throw new IllegalArgumentException("学号格式无效");
        }
        if (password == null || password.isEmpty() || password.length() > 300) {
            throw new IllegalArgumentException("密码格式无效");
        }
        JSONObject json = new JSONObject();
        json.put("username", cleanUsername);
        json.put("password", password);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[cipher.getIV().length + ciphertext.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length);
        System.arraycopy(ciphertext, 0, packed, cipher.getIV().length, ciphertext.length);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("sealed", Base64.encodeToString(packed, Base64.NO_WRAP))
                .apply();
    }

    static Credentials load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            byte[] packed = Base64.decode(prefs.getString("sealed", ""), Base64.NO_WRAP);
            if (packed.length < 29) return null;
            byte[] iv = new byte[12];
            byte[] ciphertext = new byte[packed.length - 12];
            System.arraycopy(packed, 0, iv, 0, 12);
            System.arraycopy(packed, 12, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
            JSONObject json = new JSONObject(new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            String username = json.optString("username", "").trim();
            String password = json.optString("password", "");
            if (username.isEmpty() || password.isEmpty()) return null;
            return new Credentials(username, password);
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean hasSaved(Context context) {
        return !context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("sealed", "").isEmpty();
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

    private static SecretKey getOrCreateKey() throws Exception {
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
