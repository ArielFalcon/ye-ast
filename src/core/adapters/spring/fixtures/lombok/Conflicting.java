package app;
import lombok.AccessLevel;
import lombok.Data;
import lombok.Getter;
@Data
@Getter(AccessLevel.NONE)
public class Conflicting {
  private String name;
}
