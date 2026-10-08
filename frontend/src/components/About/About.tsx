import "./About.css";

type AboutProps = {
  onClose: () => void;
};

export function About({ onClose }: AboutProps) {
  return (
    <div
      className="about-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About SnapDragons"
      >
        <button
          className="about-close"
          type="button"
          aria-label="Close about dialog"
          onClick={onClose}
        >
          ×
        </button>
        <div className="about-logos">
          <img className="about-dragon" src="/dragon.png" alt="SnapDragons" />
          <img
            className="uw-madison-mark"
            src="/uw-madison-crescent.png"
            alt="UW–Madison"
          />
        </div>
        <img
          className="qualcomm-logo"
          src="/qualcomm-logo.png"
          alt="Qualcomm"
        />
        <p>
          Continuum is developed by SnapDragons, a team of students at the University of Wisconsin–Madison. 
          This project is made possible by the sponsorship of Qualcomm.
        </p>
      </section>
    </div>
  );
}
