plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    id("org.jetbrains.kotlin.jvm") version "2.2.21" apply false
}

extra["fitbausVersionJs"] = rootProject.file("../../../version.js")
apply(from = rootProject.file("../../../scripts/fitbaus-version.gradle"))

tasks.register("printFitbausVersion") {
    doLast {
        println("FITBAUS_VERSION_NAME=${rootProject.extra["fitbausVersionName"]}")
        println("FITBAUS_VERSION_CODE=${rootProject.extra["fitbausVersionCode"]}")
    }
}
