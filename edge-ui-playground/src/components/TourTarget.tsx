import React from "react";

export interface TourTargetProps {
  id: string;
  children: React.ReactNode;
}

export const TourTarget: React.FC<TourTargetProps> = ({ id, children }) => {
  return (
    <div data-tour={id} style={{ display: "contents" }}>
      {children}
    </div>
  );
};
