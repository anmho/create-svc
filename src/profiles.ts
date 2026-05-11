export const PROFILES = ["microservice"] as const;

export type Profile = (typeof PROFILES)[number];

export function parseProfile(value: string): Profile {
  if (PROFILES.includes(value as Profile)) {
    return value as Profile;
  }

  if (value === "app") {
    throw new Error(
      [
        "The app profile moved out of create-svc.",
        "Use the private GitHub template repos anmho/create-app-consumer or anmho/create-app-saas instead.",
      ].join(" ")
    );
  }

  throw new Error(`Unknown profile: ${value}`);
}

export function exampleForProfile(profile: Profile) {
  return {
    kind: "microservice",
    domain: "waitlist",
    label: "waitlist/launch service",
  };
}
