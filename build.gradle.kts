plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.sene.patron"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sene.patron"
        minSdk = 23
        targetSdk = 35
        versionCode = 2
        versionName = "0.5.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
