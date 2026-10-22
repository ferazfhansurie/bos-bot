# Preserve generated serializers and their reflective companion entry points.
-keepattributes Signature,InnerClasses,EnclosingMethod,RuntimeVisibleAnnotations,AnnotationDefault
-keep @kotlinx.serialization.Serializable class com.openmausbot.companion.** { *; }
-keepclassmembers class com.openmausbot.companion.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.openmausbot.companion.**$$serializer { *; }

# Native barcode and encrypted storage entry points also carry consumer rules;
# retain these boundaries explicitly when shrinking the companion release.
-keep class com.google.android.libraries.barhopper.** { *; }
-keep class com.google.mlkit.vision.barcode.** { *; }
-keep class com.google.crypto.tink.** { *; }

# Tink's KeysDownloader references google-api-client and joda-time, which the
# app never ships or calls; the keep above retains it, so silence the refs.
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.Instant
