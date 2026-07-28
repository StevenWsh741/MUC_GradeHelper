package cn.muc.gradehelper.remote;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

final class ServiceRecovery {
    private static final int REQUEST_CODE = 7301;
    private static final long WATCHDOG_INTERVAL_MS = 15L * 60 * 1000;

    static void startIfEnabled(Context context) {
        if (!PairingConfig.isEnabled(context) || PairingConfig.load(context) == null) return;
        Intent service = new Intent(context, NotificationService.class)
                .setAction(NotificationService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
        } catch (RuntimeException ignored) {
            // Some OEM systems temporarily reject a background start. The watchdog will retry.
        }
    }

    static void schedule(Context context) {
        schedule(context, WATCHDOG_INTERVAL_MS);
    }

    static void scheduleSoon(Context context) {
        schedule(context, 8_000L);
    }

    private static void schedule(Context context, long delayMs) {
        if (!PairingConfig.isEnabled(context)) return;
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        long triggerAt = SystemClock.elapsedRealtime() + Math.max(5_000L, delayMs);
        alarms.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                watchdogIntent(context));
    }

    static void cancel(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(watchdogIntent(context));
    }

    private static PendingIntent watchdogIntent(Context context) {
        Intent intent = new Intent(context, ServiceWatchdogReceiver.class)
                .setAction("cn.muc.gradehelper.remote.WATCHDOG");
        return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
