package cn.muc.gradehelper.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.os.IBinder;
import android.speech.tts.TextToSpeech;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NotificationService extends Service implements TextToSpeech.OnInitListener {
    static final String ACTION_START = "cn.muc.gradehelper.remote.START";
    private static final int FOREGROUND_ID = 100;
    private static final String CHANNEL_LISTENING = "encrypted_listener";
    private static final String CHANNEL_ALERT = "new_grade_alert";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Set<String> seenNonces = new LinkedHashSet<>();
    private volatile boolean running;
    private volatile HttpURLConnection activeConnection;
    private TextToSpeech textToSpeech;
    private boolean speechReady;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        textToSpeech = new TextToSpeech(this, this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        PairingConfig config = PairingConfig.load(this);
        if (config == null || !PairingConfig.isEnabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(FOREGROUND_ID, listeningNotification("已连接加密提醒频道"));
        if (!running) {
            running = true;
            worker.execute(this::listenLoop);
        }
        return START_STICKY;
    }

    private void listenLoop() {
        while (running) {
            PairingConfig config = PairingConfig.load(this);
            if (config == null || !PairingConfig.isEnabled(this)) break;
            try {
                String endpoint = config.endpoint.replaceAll("/$", "");
                String lastRelayId = PairingConfig.getLastRelayId(this);
                String since = lastRelayId.isEmpty()
                        ? Long.toString(System.currentTimeMillis() / 1000L)
                        : lastRelayId;
                URL url = new URL(endpoint + "/" + config.topic + "/json?since="
                        + URLEncoder.encode(since, StandardCharsets.UTF_8.name()));
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                activeConnection = connection;
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(90_000);
                connection.setRequestProperty("Accept", "application/x-ndjson");
                connection.setRequestProperty("User-Agent", "MUC-GradeHelper-Android/1.0");
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                        connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while (running && (line = reader.readLine()) != null) handleLine(config, line);
                } finally {
                    connection.disconnect();
                    activeConnection = null;
                }
            } catch (Exception ignored) {
                activeConnection = null;
            }
            if (running) {
                try {
                    Thread.sleep(5_000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void handleLine(PairingConfig config, String line) {
        try {
            JSONObject event = new JSONObject(line);
            if (!"message".equals(event.optString("event"))) return;
            CryptoMessage message = CryptoMessage.decrypt(config, event.optString("message", ""));
            if (message.nonce.equals(PairingConfig.getLastMessageNonce(this))) {
                PairingConfig.setLastRelayId(this, event.optString("id", ""));
                return;
            }
            synchronized (seenNonces) {
                if (seenNonces.contains(message.nonce)) return;
                seenNonces.add(message.nonce);
                while (seenNonces.size() > 100) {
                    String first = seenNonces.iterator().next();
                    seenNonces.remove(first);
                }
            }
            showGradeAlert(message);
            PairingConfig.setLastMessageNonce(this, message.nonce);
            PairingConfig.setLastRelayId(this, event.optString("id", ""));
        } catch (Exception ignored) {
            // Invalid, stale or non-paired messages are intentionally discarded without logging contents.
        }
    }

    private void showGradeAlert(CryptoMessage message) {
        StringBuilder details = new StringBuilder();
        StringBuilder speech = new StringBuilder();
        for (CryptoMessage.Score value : message.scores) {
            if (details.length() > 0) details.append('\n');
            details.append(value.course).append("：").append(value.score);
            if (speech.length() > 0) speech.append("。");
            speech.append(value.course).append("，").append(spokenScore(value.score));
        }
        String title = message.test ? "手机提醒测试（虚构数据）" : "新成绩已发布";
        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(details.toString())
                .setStyle(new Notification.BigTextStyle().bigText(details.toString()))
                .setContentIntent(mainPendingIntent())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setColor(getColor(R.color.phoenix_red))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), notification);

        if (speechReady && textToSpeech != null) {
            String prefix = message.test ? "手机提醒测试。" : "新成绩。";
            textToSpeech.speak(prefix + speech, TextToSpeech.QUEUE_FLUSH, null, "new-grade");
        }
    }

    private String spokenScore(String score) {
        return score.matches("\\d+(?:\\.\\d+)?") ? score + "分" : score;
    }

    private Notification listeningNotification(String text) {
        return new Notification.Builder(this, CHANNEL_LISTENING)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("MUC 远程提醒已开启")
                .setContentText(text)
                .setContentIntent(mainPendingIntent())
                .setOngoing(true)
                .setColor(getColor(R.color.phoenix_red))
                .build();
    }

    private PendingIntent mainPendingIntent() {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createChannels() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel listener = new NotificationChannel(
                CHANNEL_LISTENING, "加密远程监听", NotificationManager.IMPORTANCE_LOW);
        listener.setDescription("保持加密成绩频道连接");
        manager.createNotificationChannel(listener);

        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT, "新成绩提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("新成绩通知、震动和语音播报");
        alert.enableVibration(true);
        alert.setVibrationPattern(new long[]{0, 350, 150, 500, 150, 700});
        alert.enableLights(true);
        alert.setLightColor(Color.rgb(255, 90, 20));
        AudioAttributes audio = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .build();
        alert.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI, audio);
        manager.createNotificationChannel(alert);
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS && textToSpeech != null) {
            int language = textToSpeech.setLanguage(Locale.SIMPLIFIED_CHINESE);
            speechReady = language != TextToSpeech.LANG_MISSING_DATA
                    && language != TextToSpeech.LANG_NOT_SUPPORTED;
            textToSpeech.setSpeechRate(1.35f);
            textToSpeech.setPitch(1.05f);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (activeConnection != null) activeConnection.disconnect();
        worker.shutdownNow();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
