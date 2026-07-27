package cn.muc.gradehelper.remote;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class CryptoMessage {
    private static final String PROTOCOL = "muc-grade-helper-v1";

    final boolean test;
    final String nonce;
    final long timestamp;
    final List<Score> scores;

    static final class Score {
        final String course;
        final String score;

        Score(String course, String score) {
            this.course = course;
            this.score = score;
        }
    }

    private CryptoMessage(boolean test, String nonce, long timestamp, List<Score> scores) {
        this.test = test;
        this.nonce = nonce;
        this.timestamp = timestamp;
        this.scores = scores;
    }

    static CryptoMessage decrypt(PairingConfig config, String encoded) throws Exception {
        byte[] packed = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (packed.length < 29) throw new GeneralSecurityException("密文长度无效");
        byte[] iv = new byte[12];
        byte[] ciphertextAndTag = new byte[packed.length - 12];
        System.arraycopy(packed, 0, iv, 0, 12);
        System.arraycopy(packed, 12, ciphertextAndTag, 0, ciphertextAndTag.length);

        byte[] key = Base64.decode(config.key, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD((PROTOCOL + "|" + config.topic).getBytes(StandardCharsets.UTF_8));
        byte[] plaintext = cipher.doFinal(ciphertextAndTag);
        JSONObject json = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));

        if (json.optInt("v") != 1) throw new GeneralSecurityException("不支持的消息版本");
        long timestamp = json.optLong("timestamp", 0);
        if (Math.abs(System.currentTimeMillis() - timestamp) > 24L * 60 * 60 * 1000) {
            throw new GeneralSecurityException("消息已过期");
        }
        String nonce = json.optString("nonce", "");
        if (nonce.length() < 12) throw new GeneralSecurityException("消息随机值无效");

        JSONArray values = json.optJSONArray("scores");
        if (values == null || values.length() == 0 || values.length() > 50) {
            throw new GeneralSecurityException("成绩列表无效");
        }
        List<Score> scores = new ArrayList<>();
        for (int i = 0; i < values.length(); i++) {
            JSONObject value = values.getJSONObject(i);
            String course = value.optString("course", "").trim();
            String score = value.optString("score", "").trim();
            if (!course.isEmpty() && !score.isEmpty()) scores.add(new Score(course, score));
        }
        if (scores.isEmpty()) throw new GeneralSecurityException("成绩列表为空");
        return new CryptoMessage("test".equals(json.optString("type")), nonce, timestamp, scores);
    }
}
