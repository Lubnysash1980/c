    NFC Bridge Android project with NFC support and Gradle wrapper scripts (wrapper JAR not included).


    To build APK on your machine or Termux (recommended on PC or Android with SDK):

1) If you have Gradle installed system-wide:
   cd nfc_bridge_android
   gradle wrapper
   ./gradlew assembleDebug
   (or) gradle assembleDebug

2) If you want to use the included gradlew, you must provide gradle/wrapper/gradle-wrapper.jar:
   - Option A: On a machine with gradle installed, run: gradle wrapper
   - Option B: Manually download the gradle-wrapper.jar that corresponds to the Gradle distribution (gradle-7.6.2)

The debug APK will be in:
  app/build/outputs/apk/debug/app-debug.apk

Important: The app reads NFC tag UID (HEX) and POSTs JSON {"number":"UID"} to http://10.0.2.2:5000/nfc by default.
For real devices, change the server IP to your phone's IP on the LAN (e.g. http://192.168.1.5:5000/nfc).

Security: This is a development tool. Do not use with live payment cards.
