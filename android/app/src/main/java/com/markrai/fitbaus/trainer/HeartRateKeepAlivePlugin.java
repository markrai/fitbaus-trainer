package com.markrai.fitbaus.trainer;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HeartRateKeepAlive")
public class HeartRateKeepAlivePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        Activity activity = getActivity();
        if (
            Build.VERSION.SDK_INT >= 33 &&
            activity != null &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 18013);
        }
        Intent intent = new Intent(getContext(), HeartRateKeepAliveService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), HeartRateKeepAliveService.class));
        call.resolve();
    }
}
