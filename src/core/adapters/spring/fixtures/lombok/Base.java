package app;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.Setter;
@Getter
@Setter(AccessLevel.PROTECTED)
public class Base {
  private String baseName;
  private String shadowed;
}
