package cn.muc.gradehelper.remote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class ServiceWatchdogReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!PairingConfig.isEnabled(context)) return;
        ServiceRecovery.startIfEnabled(context);
        ServiceRecovery.schedule(context);
    }
}
