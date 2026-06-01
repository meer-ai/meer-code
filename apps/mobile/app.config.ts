import type { ExpoConfig } from "expo/config";

type AppVariant = "development" | "preview" | "production";

const APP_VARIANT = resolveAppVariant(process.env.APP_VARIANT);

const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosIcon: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
  }
> = {
  development: {
    appName: "Meer Code Dev",
    scheme: "meercode-dev",
    iosIcon: "./assets/icon-composer-dev.icon",
    iosBundleIdentifier: "com.meerai.meercode.dev",
    androidPackage: "com.meerai.meercode.dev",
  },
  preview: {
    appName: "Meer Code Preview",
    scheme: "meercode-preview",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.meerai.meercode.preview",
    androidPackage: "com.meerai.meercode.preview",
  },
  production: {
    appName: "Meer Code",
    scheme: "meercode",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.meerai.meercode",
    androidPackage: "com.meerai.meercode",
  },
};

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];

const config: ExpoConfig = {
  name: variant.appName,
  slug: "meer-code",
  scheme: variant.scheme,
  version: "0.1.0",
  runtimeVersion: {
    policy: "appVersion",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  updates: {
    enabled: true,
    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.iosIcon,
    supportsTablet: true,
    bundleIdentifier: variant.iosBundleIdentifier,
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Meer Code to connect to Meer Code servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: "./assets/icon.png",
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    [
      "expo-camera",
      {
        cameraPermission: "Allow Meer Code to access your camera so you can scan pairing QR codes.",
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "16.4",
        },
      },
    ],
    "expo-secure-store",
    "expo-router",
    "expo-font",
    "./plugins/withAndroidCleartextTraffic.cjs",
  ],
  extra: {
    appVariant: APP_VARIANT,
    eas: {
      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    },
  },
  owner: "pingdotgg",
};

export default config;
