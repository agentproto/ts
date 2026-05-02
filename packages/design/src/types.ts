/**
 * AIP-4 DesignDefinition + DesignHandle.
 *
 * `DesignDefinition` was generated from
 * `resources/aip-4/draft/DESIGN.schema.json` via json-schema-to-typescript.
 * `DesignHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-4 DESIGN.md design-token kit.
 */
export type DesignDefinition = {
  [k: string]: unknown
} & {
  /**
   * Pins the registry schema this kit conforms to. Required for registry submission.
   */
  schema?: "designkit/v1"
  /**
   * Kebab-case kit identifier. Namespaced by the registry on publish.
   */
  kit: string
  /**
   * Human-readable display name.
   */
  title: string
  /**
   * One-paragraph summary surfaced in registry search results.
   */
  description?: string
  /**
   * Semver of THIS kit. Bump on token change.
   */
  version?: string
  /**
   * Display name of the author / maintainer.
   */
  author?: string
  /**
   * SPDX identifier or 'proprietary' for private brand kits.
   */
  license?: string
  homepage?: string
  /**
   * URL to a screenshot of the kit applied to a reference surface.
   */
  preview?: string
  /**
   * @minItems 0
   * @maxItems 12
   */
  tags?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
  /**
   * URI of a parent DESIGN.md to compose on top of. Depth-limited to 3.
   */
  "based-on"?: string
  /**
   * Default surface mode. 'both' requires a sibling 'variants' block.
   */
  mode?: "light" | "dark" | "both"
  colors: ColorTokens
  typography: TypographyTokens
  spacing?: ScaleTokens
  rounded?: ScaleTokens
  shadows?: ScaleTokens
  motion?: {
    duration?: ScaleTokens
    easing?: ScaleTokens
  }
  /**
   * Delta blocks per mode. Only tokens that differ from the base are listed.
   */
  variants?: {
    dark?: VariantDelta
    light?: VariantDelta
  }
  /**
   * Host-namespaced extension fields. Other hosts MUST tolerate unknown keys here.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export interface ColorTokens {
  background: string
  surface?: string
  ink: string
  "ink-muted"?: string
  primary: string
  "on-primary"?: string
  accent?: string
  "on-accent"?: string
  muted?: string
  "muted-foreground"?: string
  border?: string
  link?: string
  success?: string
  warning?: string
  danger?: string
  /**
   * Hex (#RGB / #RRGGBB / #RRGGBBAA), rgb(a), hsl(a), or '{colors.<name>}' reference.
   */
  [k: string]: string | undefined
}
export interface TypographyTokens {
  body: TypeStyle
  h1: TypeStyle
  h2?: TypeStyle
  h3?: TypeStyle
  h4?: TypeStyle
  code?: TypeStyle
  small?: TypeStyle
  [k: string]: TypeStyle | undefined
}
export interface TypeStyle {
  family: string
  size?: string
  weight?: number | string
  lineHeight?: number | string
  letterSpacing?: string
}
export interface ScaleTokens {
  [k: string]: string
}
export interface VariantDelta {
  colors?: ScaleTokens
  typography?: {
    [k: string]: TypeStyle | undefined
  }
  spacing?: ScaleTokens
  rounded?: ScaleTokens
  shadows?: ScaleTokens
  motion?: {
    duration?: ScaleTokens
    easing?: ScaleTokens
  }
}

export type DesignHandle = Readonly<DesignDefinition>
