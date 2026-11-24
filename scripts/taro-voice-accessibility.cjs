/* Taro 4.0.12 does not emit WeChat aria attributes from its base template.
 * Add only the missing template bindings after aliases have been calculated.
 * Do not extend internalComponents: that would renumber existing p0/p1 aliases
 * and require a matching runtime patch. Unknown props already retain their
 * camelCase names in Taro's hydrate and setAttribute implementations.
 */
module.exports = function voiceAccessibility(ctx) {
  ctx.registerMethod({
    name: "onSetupClose",
    fn(platform) {
      if (platform.platform !== "weapp") return;
      const template = platform.template;
      const previous = template.modifyCompProps;
      template.modifyCompProps = function modifyAccessibleProps(name, props) {
        const current = previous ? previous.call(this, name, props) : props;
        if (name === "button") {
          return { ...current, "aria-label": current["aria-label"] ?? "" };
        }
        if (name === "view") {
          return {
            ...current,
            "aria-label": current["aria-label"] ?? "",
            "aria-role": current["aria-role"] ?? "",
          };
        }
        return current;
      };
    },
  });
};
