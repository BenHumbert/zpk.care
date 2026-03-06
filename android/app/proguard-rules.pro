# zkTrident ProGuard rules

# Keep Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep all model classes (serialized)
-keep class care.zktrident.shared.model.** { *; }
-keep class care.zktrident.shared.api.** { *; }
-keep class care.zktrident.shared.crypto.** { *; }

# Keep kotlinx-serialization generated $$serializer classes
-keepclassmembers @kotlinx.serialization.Serializable class care.zktrident.** {
    static care.zktrident.**$Companion Companion;
    kotlinx.serialization.KSerializer serializer(...);
    static kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class care.zktrident.**$$serializer { *; }

# Keep Ktor client engine + plugins
-keep class io.ktor.** { *; }
-keep class io.ktor.client.engine.** { *; }
-keep class io.ktor.client.plugins.** { *; }
-dontwarn io.ktor.**

# Keep OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Coroutines
-dontwarn kotlinx.coroutines.**
-keep class kotlinx.coroutines.** { *; }

# SLF4J (Ktor dependency)
-dontwarn org.slf4j.**
