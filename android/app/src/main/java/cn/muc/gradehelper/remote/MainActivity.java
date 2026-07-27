package cn.muc.gradehelper.remote;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private EditText pairingCode;
    private EditText usernameInput;
    private EditText passwordInput;
    private TextView statusText;
    private TextView credentialStatus;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(R.layout.activity_main);
        pairingCode = findViewById(R.id.pairingCode);
        usernameInput = findViewById(R.id.usernameInput);
        passwordInput = findViewById(R.id.passwordInput);
        statusText = findViewById(R.id.statusText);
        credentialStatus = findViewById(R.id.credentialStatus);

        findViewById(R.id.pasteButton).setOnClickListener(this::pasteCode);
        findViewById(R.id.startButton).setOnClickListener(this::startListening);
        findViewById(R.id.stopButton).setOnClickListener(this::stopListening);
        findViewById(R.id.remoteStartButton).setOnClickListener(this::saveAndStartComputer);
        findViewById(R.id.clearCredentialsButton).setOnClickListener(this::clearCredentials);
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
            clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
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

    private void saveAndStartComputer(View button) {
        PairingConfig config = PairingConfig.load(this);
        if (config == null || !PairingConfig.isEnabled(this)) {
            Toast.makeText(this, "请先完成配对并开启远程提醒", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            String username = usernameInput.getText().toString();
            String password = passwordInput.getText().toString();
            CredentialVault.Credentials credentials;
            if (!username.trim().isEmpty() || !password.isEmpty()) {
                CredentialVault.save(this, username, password);
                credentials = CredentialVault.load(this);
            } else {
                credentials = CredentialVault.load(this);
            }
            usernameInput.setText("");
            passwordInput.setText("");
            if (credentials == null) throw new IllegalArgumentException("请先输入学号和密码");

            button.setEnabled(false);
            credentialStatus.setText("凭据已由 Keystore 加密保存，正在发送一次性启动指令……");
            RemoteCommandSender.sendStart(config, credentials, error -> runOnUiThread(() -> {
                button.setEnabled(true);
                if (error == null) {
                    credentialStatus.setText("启动指令已加密发送，等待电脑回执");
                    Toast.makeText(this, "已发送，请查看电脑是否开始打开网页", Toast.LENGTH_LONG).show();
                } else {
                    credentialStatus.setText("发送失败，已保存的凭据仍在本机加密保险箱中");
                    Toast.makeText(this, "发送失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                }
            }));
        } catch (Exception error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void clearCredentials(View ignored) {
        CredentialVault.clear(this);
        usernameInput.setText("");
        passwordInput.setText("");
        refreshCredentialStatus();
        Toast.makeText(this, "本机保存的学号和密码已清除", Toast.LENGTH_LONG).show();
    }

    private void refreshStatus() {
        if (PairingConfig.isEnabled(this) && PairingConfig.load(this) != null) {
            statusText.setText("状态：已配对，远程提醒正在运行");
            statusText.setTextColor(getColor(R.color.phoenix_red));
        } else {
            statusText.setText("状态：未配对");
            statusText.setTextColor(getColor(R.color.ink));
        }
        refreshCredentialStatus();
    }

    private void refreshCredentialStatus() {
        if (CredentialVault.hasSaved(this)) {
            credentialStatus.setText("本机已使用 Android Keystore 加密保存凭据");
        } else {
            credentialStatus.setText("本机尚未保存学校账号凭据");
        }
    }
}
