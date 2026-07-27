package cn.muc.gradehelper.remote;

import android.Manifest;
import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private EditText pairingCode;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        pairingCode = findViewById(R.id.pairingCode);
        statusText = findViewById(R.id.statusText);

        findViewById(R.id.pasteButton).setOnClickListener(this::pasteCode);
        findViewById(R.id.startButton).setOnClickListener(this::startListening);
        findViewById(R.id.stopButton).setOnClickListener(this::stopListening);
        refreshStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
    }

    private void pasteCode(View ignored) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard.hasPrimaryClip() && clipboard.getPrimaryClip() != null
                && clipboard.getPrimaryClip().getItemCount() > 0) {
            CharSequence value = clipboard.getPrimaryClip().getItemAt(0).coerceToText(this);
            pairingCode.setText(value);
            Toast.makeText(this, "配对码已粘贴", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "剪贴板中没有文本", Toast.LENGTH_SHORT).show();
        }
    }

    private void startListening(View ignored) {
        try {
            PairingConfig config = PairingConfig.parse(pairingCode.getText().toString());
            config.save(this);
            pairingCode.setText("");
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
            Intent intent = new Intent(this, NotificationService.class).setAction(NotificationService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
            else startService(intent);
            refreshStatus();
            Toast.makeText(this, "远程提醒已开启", Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(this, "无法配对：" + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void stopListening(View ignored) {
        PairingConfig.setEnabled(this, false);
        stopService(new Intent(this, NotificationService.class));
        PairingConfig.clear(this);
        refreshStatus();
        Toast.makeText(this, "已停止监听并清除配对信息", Toast.LENGTH_LONG).show();
    }

    private void refreshStatus() {
        if (PairingConfig.isEnabled(this) && PairingConfig.load(this) != null) {
            statusText.setText("状态：已配对，远程提醒正在运行");
            statusText.setTextColor(getColor(R.color.phoenix_red));
        } else {
            statusText.setText("状态：未配对");
            statusText.setTextColor(getColor(R.color.ink));
        }
    }
}
