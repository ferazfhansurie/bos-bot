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
-keep class com.google.mlkit.** { *; }
-keep class com.google.crypto.tink.** { *; }

# ML Kit's MlKitInitProvider runs before any Activity and loads its component
# registrars by the class names written into manifest meta-data
# (com.google.firebase.components:<class>). Keeping only vision.barcode let R8
# rename CommonComponentRegistrar and VisionCommonRegistrar, and 2.1.3 crashed
# on launch on every device ("Unsatisfied dependency ... class w41").
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
-keep class com.google.firebase.components.** { *; }

# Tink's KeysDownloader references google-api-client and joda-time, which the
# app never ships or calls; the keep above retains it, so silence the refs.
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.Instant
