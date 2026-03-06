plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
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

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // ─── 5 Product Flavors ──────────────────────────────────────
    flavorDimensions += "role"

    productFlavors {
        create("member") {
            dimension = "role"
            applicationId = "care.zktrident.member"
            resValue("string", "app_name", "zkCare Member")
            buildConfigField("String", "ROLE", "\"member\"")
            buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
            buildConfigField("String", "DEFAULT_PROVER_URL", "\"https://zktrident-prover.onrender.com\"")
        }
        create("pharmacy") {
            dimension = "role"
            applicationId = "care.zktrident.pharmacy"
            resValue("string", "app_name", "zkCare Pharmacy")
            buildConfigField("String", "ROLE", "\"pharmacy\"")
            buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
            buildConfigField("String", "DEFAULT_PROVER_URL", "\"https://zktrident-prover.onrender.com\"")
        }
        create("prescriber") {
            dimension = "role"
            applicationId = "care.zktrident.prescriber"
            resValue("string", "app_name", "zkCare Prescriber")
            buildConfigField("String", "ROLE", "\"prescriber\"")
            buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
            buildConfigField("String", "DEFAULT_PROVER_URL", "\"https://zktrident-prover.onrender.com\"")
        }
        create("insurer") {
            dimension = "role"
            applicationId = "care.zktrident.insurer"
            resValue("string", "app_name", "zkCare Insurer")
            buildConfigField("String", "ROLE", "\"insurer\"")
            buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
            buildConfigField("String", "DEFAULT_PROVER_URL", "\"\"")
        }
        create("employer") {
            dimension = "role"
            applicationId = "care.zktrident.employer"
            resValue("string", "app_name", "zkCare Employer")
            buildConfigField("String", "ROLE", "\"employer\"")
            buildConfigField("String", "DEFAULT_SEQUENCER_URL", "\"https://zktrident-leviathan.onrender.com\"")
            buildConfigField("String", "DEFAULT_PROVER_URL", "\"\"")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Shared KMP module
    implementation(project(":shared"))

    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.02.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Lifecycle + ViewModel
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Activity
    implementation("androidx.activity:activity-compose:1.8.2")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    // Material3 XML theme (for splash/launch window before Compose loads)
    implementation("com.google.android.material:material:1.11.0")

    // NFC (member flavor only, but included for all — gated by manifest feature)
    implementation("androidx.core:core-ktx:1.12.0")

    // Testing
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}
