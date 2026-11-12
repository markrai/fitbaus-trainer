import java.io.File
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
}

group = "com.fitbaus.bikebridge"
version = "0.1.0-f1"

val fitbausVersionName = rootProject.extra["fitbausVersionName"] as String
val generatedVersionDir = layout.buildDirectory.dir("generated/sources/fitbausVersion/kotlin")

val generateFitbausVersion = tasks.register("generateFitbausVersion") {
    val versionName = fitbausVersionName
    val outputDir = generatedVersionDir
    inputs.property("versionName", versionName)
    outputs.dir(outputDir)
    doLast {
        val pkg = outputDir.get().asFile.resolve("com/fitbaus/bikebridge/protocol")
        pkg.mkdirs()
        File(pkg, "FitbausProductVersion.kt").writeText(
            """
            |package com.fitbaus.bikebridge.protocol
            |
            |public object FitbausProductVersion {
            |    public const val NAME: String = "$versionName"
            |}
            |""".trimMargin(),
        )
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

kotlin {
    explicitApi()
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
        allWarningsAsErrors.set(true)
    }
    sourceSets.named("main") {
        kotlin.srcDir(generatedVersionDir)
    }
}

tasks.named("compileKotlin").configure {
    dependsOn(generateFitbausVersion)
}
tasks.named("compileTestKotlin").configure {
    dependsOn(generateFitbausVersion)
}

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.2.21")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5:2.2.21")
    testImplementation("org.junit.jupiter:junit-jupiter-api:5.10.1")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.10.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.1")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

tasks.register("printFitbausVersion") {
    dependsOn(generateFitbausVersion)
    doLast {
        val generated = generatedVersionDir.get().asFile.resolve(
            "com/fitbaus/bikebridge/protocol/FitbausProductVersion.kt",
        )
        val match = Regex("""NAME:\s*String\s*=\s*"([^"]+)"""").find(generated.readText())
            ?: throw GradleException("Generated FitbausProductVersion.kt is missing NAME")
        println("FITBAUS_VERSION_NAME=${match.groupValues[1]}")
        println("FITBAUS_PROTOCOL_VERSION=${match.groupValues[1]}")
    }
}
