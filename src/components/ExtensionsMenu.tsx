import { tr } from "../services/preferences";
import type { ChannelExtension, ExtensionType } from "../services/extensions";

function typeKey(type: ExtensionType) {
  return type === "overlay"
    ? "Overlay"
    : type === "component"
      ? "Composant"
      : "Panneau";
}

export function ExtensionsList({
  extensions,
  onOpen,
  popoutUrl,
}: {
  extensions: ChannelExtension[];
  onOpen: (extension: ChannelExtension) => void;
  popoutUrl: (extension: ChannelExtension) => string;
}) {
  return (
    <>
      {extensions.map((extension) => (
        <div
          className="extensions-row"
          data-extension={extension.id}
          key={extension.id}
        >
          <img
            src={extension.icon || "favicon.svg"}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <div>
            <span className="extensions-name" title={extension.description}>
              {extension.name}
            </span>
            <small data-i18n={typeKey(extension.type)}>
              {typeKey(extension.type)}
            </small>
          </div>
          <button
            type="button"
            onClick={() => onOpen(extension)}
            data-i18n="Ouvrir la fenêtre"
            aria-label={tr("Ouvrir la fenêtre de {name}", {
              name: extension.name,
            })}
            title={tr("Ouvrir la fenêtre de {name}", { name: extension.name })}
          >
            Ouvrir la fenêtre
          </button>
          <a
            href={popoutUrl(extension)}
            target="_blank"
            rel="noopener noreferrer"
            title={tr("Ouvrir {name} sur Twitch ↗", { name: extension.name })}
            aria-label={tr("Ouvrir {name} sur Twitch ↗", {
              name: extension.name,
            })}
          >
            Twitch ↗
          </a>
        </div>
      ))}
    </>
  );
}
