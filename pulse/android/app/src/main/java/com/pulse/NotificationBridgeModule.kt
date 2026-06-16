package com.pulse

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.provider.Settings
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream

object NotificationEmitter {
  private var reactContext: ReactApplicationContext? = null

  fun register(context: ReactApplicationContext) {
    reactContext = context
  }

  fun unregister() {
    reactContext = null
  }

  fun emit(payload: WritableMap) {
    reactContext
      ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit("PulseNotificationReceived", payload)
  }
}

class NotificationBridgeModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName() = "NotificationBridgeModule"

  override fun initialize() {
    super.initialize()
    NotificationEmitter.register(context)
  }

  override fun invalidate() {
    NotificationEmitter.unregister()
    super.invalidate()
  }

  @ReactMethod
  fun checkNotificationAccess(promise: Promise) {
    val enabledListeners =
      Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: ""
    val serviceName = ComponentName(context, NotificationService::class.java).flattenToString()
    promise.resolve(enabledListeners.contains(serviceName))
  }

  @ReactMethod
  fun openNotificationAccessSettings(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SETTINGS_ERROR", e)
    }
  }

  @ReactMethod
  fun getInstalledBankingApps(promise: Promise) {
    try {
      val apps = context.packageManager.getInstalledApplications(0)
      val result = Arguments.createArray()
      for (app in apps) {
        val pkg = app.packageName.lowercase()
        if (
          pkg.contains("bank") ||
            pkg.contains("finance") ||
            pkg.contains("upi") ||
            pkg.contains("pay") ||
            pkg.contains("wallet")
        ) {
          result.pushString(app.packageName)
        }
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("BANKING_APPS_ERROR", e)
    }
  }

  @ReactMethod
  fun getApplicationIcon(packageName: String, promise: Promise) {
    try {
      val drawable = context.packageManager.getApplicationIcon(packageName)
      val bitmap: Bitmap =
        if (drawable is BitmapDrawable && drawable.bitmap != null) {
          drawable.bitmap
        } else {
          val width = drawable.intrinsicWidth.takeIf { it > 0 } ?: 96
          val height = drawable.intrinsicHeight.takeIf { it > 0 } ?: 96
          val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
          val canvas = Canvas(output)
          drawable.setBounds(0, 0, canvas.width, canvas.height)
          drawable.draw(canvas)
          output
        }
      val stream = ByteArrayOutputStream()
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
      val encoded = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
      promise.resolve("data:image/png;base64,$encoded")
    } catch (_: Exception) {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun seedDemoNotifications(promise: Promise) {
    val demos =
      listOf(
        Triple("com.google.android.apps.walletnfcrel", "Google Wallet", "You paid ₹450 to Zomato"),
        Triple("com.google.android.gm", "Gmail", "Payment of $12.99 to Netflix confirmed"),
        Triple("com.whatsapp", "WhatsApp", "₹45,000 credited to your account from ACME Payroll")
      )

    demos.forEach { (pkg, title, text) ->
      val payload = Arguments.createMap().apply {
        putString("sourceApp", pkg)
        putString("title", title)
        putString("text", text)
        putString("subText", "Demo mode")
        putString("bigText", text)
      }
      NotificationEmitter.emit(payload)
    }

    promise.resolve(true)
  }
}
