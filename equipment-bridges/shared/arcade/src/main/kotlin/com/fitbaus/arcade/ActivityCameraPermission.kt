// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process

internal class ActivityCameraPermission(
    private val activity: Activity,
    private val requestCode: Int,
) : CameraPermissionGate {
    override fun isGranted(): Boolean =
        activity.checkPermission(Manifest.permission.CAMERA, Process.myPid(), Process.myUid()) ==
            PackageManager.PERMISSION_GRANTED

    override fun canRequest(): Boolean = Build.VERSION.SDK_INT >= 23

    override fun request() {
        if (Build.VERSION.SDK_INT >= 23) {
            activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), requestCode)
        }
    }
}
