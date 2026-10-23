package org.openbot.app.robot;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.annotation.NonNull;
import androidx.preference.PreferenceManager;
import org.jetbrains.annotations.NotNull;
import org.openbot.app.robot.vehicle.Vehicle;
import timber.log.Timber;

public class OpenBotApplication extends Application {

  static Context context;
  public static Vehicle vehicle;

  public static Context getContext() {
    return context;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    context = getApplicationContext();

    if (BuildConfig.DEBUG) {
      Timber.plant(
          new Timber.DebugTree() {
            @NonNull
            @Override
            protected String createStackElementTag(@NotNull StackTraceElement element) {
              return super.createStackElementTag(element) + ":" + element.getLineNumber();
            }
          });
    }

    SharedPreferences sharedPreferences = PreferenceManager.getDefaultSharedPreferences(this);
    int baudRate;
    try {
      baudRate = Integer.parseInt(sharedPreferences.getString("baud_rate", "115200"));
    } catch (NumberFormatException exception) {
      baudRate = 115200;
      Timber.w(exception, "Invalid baud rate preference; using 115200");
    }
    vehicle = new Vehicle(this, baudRate);
    // Keep hardware discovery out of the critical application startup path.
    // On Android 12+ Bluetooth permissions are granted by the activity, and a
    // phone may not expose USB/BLE hardware at all. Neither case should prevent
    // the JiaoJiao-Luo UI from opening.
    try {
      vehicle.initBle();
    } catch (RuntimeException exception) {
      Timber.e(exception, "BLE initialization deferred until permissions are available");
    }
    try {
      vehicle.connectUsb();
    } catch (RuntimeException exception) {
      Timber.e(exception, "USB initialization deferred until a robot is connected");
    }
  }

  @Override
  public void onTerminate() {
    super.onTerminate();
  }
}
