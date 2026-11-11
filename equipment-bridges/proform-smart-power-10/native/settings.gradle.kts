pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "fitbaus-bikebridge-native"

include(":equipment-protocol")
include(":equipment-usb-probe")
include(":bridge-app")

include(":arcade")
project(":arcade").projectDir = file("../../shared/arcade")
