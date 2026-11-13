import type { WorkspaceActions } from "../types/actions";
export function Workspace({ actions }: { actions: WorkspaceActions }) {
  return (
    <>
      <main id="main">
        <div id="grid"></div>
        <div
          className="chat-resize spotlight-resize"
          role="separator"
          tabIndex={0}
          aria-label="Redimensionner les tuiles"
          data-i18n-aria-label="Redimensionner les tuiles"
        />
        <section id="empty" aria-labelledby="empty-title">
          <span className="hero">
            <span className="float">
              <img src="favicon.svg" alt="" />
            </span>
          </span>
          <h1 id="empty-title">Twitch grid</h1>
          <p data-i18n="">
            Ta grille est vide. Trois gestes et tes streams sont côte à côte.
          </p>
          <ol className="start">
            <li>
              <b>1</b>
              <h2 data-i18n="">Trouve une chaîne</h2>
              <span data-i18n="">
                Dans la liste : tes follows, ou une recherche par pseudo ou lien
                Twitch.
              </span>
            </li>
            <li>
              <b>2</b>
              <h2 data-i18n="">Ajoute-la à la grille</h2>
              <span data-i18n="">
                Un clic sur une chaîne en direct ouvre son lecteur ici.
              </span>
            </li>
            <li>
              <b>3</b>
              <h2 data-i18n="">Passe en spotlight, choisis le son</h2>
              <span data-i18n="">
                Clique une vidéo pour l’agrandir. Le son la suit, les autres se
                taisent.
              </span>
            </li>
          </ol>
          <button
            id="guest"
            onClick={() => actions.findStreamer?.()}
            data-i18n="Rechercher un streamer"
          >
            Rechercher un streamer
          </button>
          <span className="links">
            <button
              id="top"
              onClick={() => actions.connect?.()}
              className="link"
              data-i18n="Connecter Twitch"
            >
              Connecter Twitch
            </button>
            <button
              id="show-landing"
              onClick={() => actions.showLanding?.()}
              className="link"
              type="button"
              data-i18n=""
            >
              Revoir la présentation
            </button>
          </span>
        </section>
        <button
          id="update"
          type="button"
          hidden
          onClick={() => location.reload()}
          data-i18n="Nouvelle version, clique pour recharger"
        >
          Nouvelle version, clique pour recharger
        </button>
        <div
          id="live-notifications"
          role="region"
          aria-label="Nouveaux streams en direct"
          data-i18n-aria-label="Nouveaux streams en direct"
          aria-live="polite"
          aria-relevant="additions"
        ></div>
      </main>
    </>
  );
}
