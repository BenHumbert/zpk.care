plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "care.zktrident.app"
    compileSdk = 34

    defaultConfig {
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"http://192.168.139.171:3030\"")
        buildConfigField("String", "DEFAULT_PROVER_URL", "\"http://192.168.139.171:4040\"")
        buildConfigField("String", "DEFAULT_INSURER_URL", "\"http://192.168.139.171:4004\"")
        buildConfigField("String", "DEFAULT_PROVER_API_KEY", "\"dev-key\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    flavorDimensions += "role"
    productFlavors {
        create("member") {
            dimension = "role"
            applicationId = "care.zktrident.member"
            resValue("string", "app_name", "zkTrident Member")
            buildConfigField("String", "ROLE", "\"member\"")
        }
        create("pharmacy") {
            dimension = "role"
            applicationId = "care.zktrident.pharmacy"
            resValue("string", "app_name", "zkTrident Pharmacy")
            buildConfigField("String", "ROLE", "\"pharmacy\"")
        }
        create("prescriber") {
            dimension = "role"
            applicationId = "care.zktrident.prescriber"
            resValue("string", "app_name", "zkTrident Prescriber")
            buildConfigField("String", "ROLE", "\"prescriber\"")
        }
        create("insurer") {
            dimension = "role"
            applicationId = "care.zktrident.insurer"
            resValue("string", "app_name", "zkTrident Insurer")
            buildConfigField("String", "ROLE", "\"insurer\"")
        }
        create("employer") {
            dimension = "role"
            applicationId = "care.zktrident.employer"
            resValue("string", "app_name", "zkTrident Employer")
            buildConfigField("String", "ROLE", "\"employer\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":shared"))

    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Lifecycle + ViewModel
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.6")

    // Biometric (optional, for PIN/fingerprint)
    implementation("androidx.biometric:biometric:1.2.0-alpha05")

    // NFC
    // (uses Android SDK NFC APIs directly)

    // Serialization
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
