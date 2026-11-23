# FitBaus documentation

FitBaus is primarily a static, self-hostable workout trainer. Its native Bike Bridge and console games are optional and currently support one specific ProForm bike.

## Start here

- [Self-host the web trainer](SELF-HOSTING.md): deploy the static files using your own web server or Docker and an HTTPS reverse proxy
- [Native development](NATIVE-DEVELOPMENT.MD): build the Android and iOS applications
- [Connect YouTube on a compatible bike console](YOUTUBE-GOOGLE-OAUTH-SETUP.md): optional Google OAuth setup
- [Personalization architecture](personalization-architecture.md): contributor-facing explanation of the training model and what controls the equipment

For the exact supported bike model, requirements and safety boundaries, see the [ProForm integration guide](../equipment-bridges/proform-smart-power-10/README.md).

Maintainer release procedures, signed-APK verification records and release plans live under [`.github/release/`](../.github/release/RELEASE.md). Historical engineering research lives under [`.github/engineering/`](../.github/engineering/adaptive-training-architecture-review.md). Those files are still available to contributors but are not part of the installation guide.
