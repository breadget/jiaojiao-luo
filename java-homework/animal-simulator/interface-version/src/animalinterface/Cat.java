package animalinterface;

/** (3) 实现 Animal 接口的猫类 */
public class Cat implements Animal {
    @Override
    public void cry() {
        System.out.println("喵喵喵！");
    }

    @Override
    public String getAnimalName() {
        return "猫";
    }
}
