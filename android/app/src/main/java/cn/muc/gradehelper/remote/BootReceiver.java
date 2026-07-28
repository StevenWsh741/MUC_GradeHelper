package cn.muc.gradehelper.remote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !Intent.ACTION_USER_UNLOCKED.equals(action)) return;
        ServiceRecovery.startIfEnabled(context);
        ServiceRecovery.schedule(context);
    }
}
