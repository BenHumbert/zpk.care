plugins {
    kotlin("multiplatform")
    id("com.android.library")
    kotlin("plugin.serialization")
}

kotlin {
    androidTarget {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
                }
            }
        }
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                // HTTP client
                implementation("io.ktor:ktor-client-core:2.3.8")
                implementation("io.ktor:ktor-client-content-negotiation:2.3.8")
                implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.8")

                // Serialization
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

                // Coroutines
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
            }
        }
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
            }
        }
        val androidMain by getting {
            dependencies {
                // Ktor Android engine
                implementation("io.ktor:ktor-client-okhttp:2.3.8")

                // Android Keystore
                implementation("androidx.security:security-crypto:1.1.0-alpha06")
            }
        }
    }
}

android {
    namespace = "care.zktrident.shared"
    compileSdk = 34
    defaultConfig {
        minSdk = 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
